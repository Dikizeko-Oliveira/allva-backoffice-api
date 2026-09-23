import {
  Storage,
  type Bucket,
  type StorageOptions,
} from '@google-cloud/storage';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  StoragePortInterface,
  type StorageProviderName,
} from 'src/shared/application/ports/storage.port';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import {
  buildGcsObjectUrl,
  extractGcsObjectKey,
  ownsGcsUrl,
} from './gcs-object-url';
import { signedUrlWindow } from './signed-url-window';
import { buildObjectKey } from './storage-object-key';

/** Mesma validade do presigned do S3 — trocar uma sem a outra confunde o front. */
const PRESIGNED_URL_TTL_SECONDS = 3600;

/** Validade mínima de uma URL de leitura. Ver `signedUrlWindow` para o teto. */
const READ_URL_TTL_SECONDS = 3600;

/**
 * Google Cloud Storage, o provedor padrão (`STORAGE_PROVIDER=GCS`).
 *
 * Três coisas separam esta implementação de uma tradução linha a linha do S3:
 *
 * - **O cliente é preguiçoso.** `new Storage()` resolve credencial na primeira
 *   chamada, não no construtor, mas o provider é instanciado no boot de toda
 *   instalação — inclusive as que nunca vão subir arquivo. Adiar a construção é o
 *   que mantém a regra do projeto de que credencial opcional ausente degrada com
 *   log e nunca derruba o processo.
 * - **Sem bucket, a recusa é declarada.** Um `GCS_BUCKET` em branco viraria uma
 *   chamada a `bucket('')` e um erro de rede sem sentido; aqui vira
 *   `STORAGE_NOT_CONFIGURED`, que diz o que falta.
 * - **Credencial é opcional de propósito.** Sem chave explícita o SDK cai em
 *   Application Default Credentials, que é exatamente como isto deve rodar em
 *   Cloud Run/GKE — service account anexada à instância, nenhum segredo no
 *   ambiente. Chave em `.env` é o caminho de fora do Google, não o preferencial.
 */
@Injectable()
export class GcsStorageProvider implements StoragePortInterface {
  readonly provider: StorageProviderName = 'gcs';

  private readonly logger = new Logger(GcsStorageProvider.name);
  private readonly bucketName: string;
  private readonly publicBaseUrl?: string;
  private client?: Storage;

  constructor(private readonly env: EnvService) {
    this.bucketName = this.env.get('GCS_BUCKET')?.trim() ?? '';
    this.publicBaseUrl =
      this.env.get('GCS_PUBLIC_BASE_URL')?.trim() || undefined;
  }

  async upload(
    file: Buffer,
    filename: string,
    mimeType: string,
    folder: string = 'creatives',
    campaignName?: string,
  ): Promise<{ url: string; key: string }> {
    const key = buildObjectKey(filename, folder, campaignName);

    try {
      // `resumable: false` porque tudo que passa por aqui já está inteiro em
      // memória: sessão retomável custa uma ida e volta extra e só paga a si
      // mesma em upload por streaming, que este port não expõe.
      await this.requireBucket()
        .file(key)
        .save(file, { contentType: mimeType, resumable: false });

      const url = this.urlFor(key);

      this.logger.log(`File uploaded successfully: ${url}`);

      return { url, key };
    } catch (error) {
      this.logger.error('Error uploading file to GCS', error);
      throw error;
    }
  }

  async getPresignedUrl(
    filename: string,
    mimeType: string,
    folder: string = 'creatives',
    campaignName?: string,
  ): Promise<{ uploadUrl: string; fileUrl: string; key: string }> {
    const key = buildObjectKey(filename, folder, campaignName);

    try {
      // V4 é a assinatura corrente; a V2 do SDK é legado e tem validade máxima
      // diferente. `contentType` obriga o cliente a enviar o mesmo cabeçalho —
      // é o que impede que a URL assinada para um PNG receba um executável.
      const [uploadUrl] = await this.requireBucket()
        .file(key)
        .getSignedUrl({
          version: 'v4',
          action: 'write',
          expires: Date.now() + PRESIGNED_URL_TTL_SECONDS * 1000,
          contentType: mimeType,
        });

      this.logger.log(`Presigned URL generated for key: ${key}`);

      // A URL de leitura pode apontar para o CDN; a de escrita, nunca — domínio
      // próprio na frente do bucket costuma servir só GET, e o PUT assinado
      // precisa chegar ao host que assinou.
      return { uploadUrl, fileUrl: this.urlFor(key), key };
    } catch (error) {
      this.logger.error('Error generating presigned URL', error);
      throw error;
    }
  }

  ownsUrl(fileUrl: string): boolean {
    return ownsGcsUrl(fileUrl, {
      bucket: this.bucketName,
      publicBaseUrl: this.publicBaseUrl,
    });
  }

  async getReadUrl(
    fileUrl: string,
    ttlSeconds: number = READ_URL_TTL_SECONDS,
  ): Promise<string> {
    if (!this.ownsUrl(fileUrl)) return fileUrl;

    const key = this.keyOf(fileUrl);
    const { expiresAt } = signedUrlWindow(ttlSeconds);

    const [url] = await this.requireBucket()
      .file(key)
      .getSignedUrl({ version: 'v4', action: 'read', expires: expiresAt });

    return url;
  }

  async deleteByUrl(fileUrl: string): Promise<void> {
    const key = this.keyOf(fileUrl);

    try {
      // `ignoreNotFound` alinha o comportamento ao do S3, cujo DeleteObject é
      // idempotente: quem apaga duas vezes — retry de fila, reprocessamento —
      // não pode receber erro na segunda.
      await this.requireBucket().file(key).delete({ ignoreNotFound: true });

      this.logger.log(`File deleted successfully: ${key}`);
    } catch (error) {
      this.logger.error(`Error deleting file from GCS: ${key}`, error);
      throw error;
    }
  }

  private keyOf(fileUrl: string): string {
    return extractGcsObjectKey(fileUrl, {
      bucket: this.bucketName,
      publicBaseUrl: this.publicBaseUrl,
    });
  }

  private urlFor(key: string): string {
    return buildGcsObjectUrl(key, {
      bucket: this.bucketName,
      publicBaseUrl: this.publicBaseUrl,
    });
  }

  private requireBucket(): Bucket {
    if (!this.bucketName) {
      throw new ServiceUnavailableException({
        code: 'STORAGE_NOT_CONFIGURED',
        message: 'GCS storage is not configured: set GCS_BUCKET',
      });
    }

    this.client ??= new Storage(this.buildOptions());

    return this.client.bucket(this.bucketName);
  }

  private buildOptions(): StorageOptions {
    const options: StorageOptions = {};

    const projectId = this.env.get('GCS_PROJECT_ID')?.trim();
    if (projectId) options.projectId = projectId;

    const keyFilename = this.env.get('GCS_KEY_FILENAME')?.trim();
    if (keyFilename) {
      options.keyFilename = keyFilename;
      return options;
    }

    const clientEmail = this.env.get('GCS_CLIENT_EMAIL')?.trim();
    const privateKey = this.env.get('GCS_PRIVATE_KEY');

    if (clientEmail && privateKey?.trim()) {
      options.credentials = {
        client_email: clientEmail,
        // A chave PEM é multilinha e o `.env` é de uma linha só: o que chega
        // aqui traz `\n` literal, e o SDK rejeita a assinatura sem a quebra
        // real. Aspas no `.env` preservam a barra invertida, não a quebra.
        private_key: privateKey.replace(/\\n/g, '\n'),
      };
    }

    // Nenhum dos dois: Application Default Credentials assume, como deve ser
    // dentro do Google Cloud.
    return options;
  }
}
