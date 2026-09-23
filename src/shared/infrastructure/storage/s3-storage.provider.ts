import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  PutObjectCommandInput,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
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
import { signedUrlWindow } from './signed-url-window';
import { buildObjectKey, decodeObjectKey } from './storage-object-key';

/** Mesma validade do presigned do GCS — trocar uma sem a outra confunde o front. */
const PRESIGNED_URL_TTL_SECONDS = 3600;

/** Validade mínima de uma URL de leitura. Ver `signedUrlWindow` para o teto. */
const READ_URL_TTL_SECONDS = 3600;

const DEFAULT_REGION = 'us-east-1';

/**
 * Amazon S3, agora o provedor alternativo (`STORAGE_PROVIDER=S3`).
 *
 * Passou a ler a configuração pelo `EnvService` em vez de `process.env` direto:
 * era o último provider de infraestrutura a contornar o schema validado, e o
 * `region` com default local fazia a URL montada abaixo divergir do endpoint
 * usado pelo cliente quando a variável faltava — objeto no lugar certo, link
 * apontando para `undefined`.
 *
 * O cliente também ficou preguiçoso, pela mesma razão do GCS: com o S3 fora de
 * uso, nada justifica construí-lo em toda instalação.
 */
@Injectable()
export class S3StorageProvider implements StoragePortInterface {
  readonly provider: StorageProviderName = 's3';

  private readonly logger = new Logger(S3StorageProvider.name);
  private readonly bucketName: string;
  private readonly region: string;
  private client?: S3Client;

  constructor(private readonly env: EnvService) {
    this.bucketName = this.env.get('AWS_S3_BUCKET')?.trim() ?? '';
    this.region = this.env.get('AWS_REGION')?.trim() || DEFAULT_REGION;
  }

  async upload(
    file: Buffer,
    filename: string,
    mimeType: string,
    folder: string = 'creatives',
    campaignName?: string,
  ): Promise<{ url: string; key: string }> {
    const key = buildObjectKey(filename, folder, campaignName);

    const params: PutObjectCommandInput = {
      Bucket: this.requireBucket(),
      Key: key,
      Body: file,
      ContentType: mimeType,
    };

    try {
      await this.requireClient().send(new PutObjectCommand(params));

      const url = this.urlFor(key);

      this.logger.log(`File uploaded successfully: ${url}`);

      return { url, key };
    } catch (error) {
      this.logger.error('Error uploading file to S3', error);
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

    const command = new PutObjectCommand({
      Bucket: this.requireBucket(),
      Key: key,
      ContentType: mimeType,
    });

    try {
      const uploadUrl = await getSignedUrl(this.requireClient(), command, {
        expiresIn: PRESIGNED_URL_TTL_SECONDS,
      });

      this.logger.log(`Presigned URL generated for key: ${key}`);

      return { uploadUrl, fileUrl: this.urlFor(key), key };
    } catch (error) {
      this.logger.error('Error generating presigned URL', error);
      throw error;
    }
  }

  ownsUrl(fileUrl: string): boolean {
    if (!this.bucketName) return false;

    try {
      return new URL(fileUrl).host === this.publicHost();
    } catch {
      // URL malformada gravada em banco não pode derrubar a resposta inteira.
      return false;
    }
  }

  async getReadUrl(
    fileUrl: string,
    ttlSeconds: number = READ_URL_TTL_SECONDS,
  ): Promise<string> {
    if (!this.ownsUrl(fileUrl)) return fileUrl;

    const command = new GetObjectCommand({
      Bucket: this.requireBucket(),
      Key: this.extractKeyFromUrl(fileUrl),
    });

    // `signingDate` fixo no início da janela é o que torna a URL estável: o
    // SigV4 assina o instante, então sem isto cada requisição produziria uma
    // assinatura diferente e o cache do browser nunca acertaria.
    const { signedAt, expiresAt } = signedUrlWindow(ttlSeconds);

    return getSignedUrl(this.requireClient(), command, {
      signingDate: signedAt,
      expiresIn: Math.floor((expiresAt.getTime() - signedAt.getTime()) / 1000),
    });
  }

  async deleteByUrl(fileUrl: string): Promise<void> {
    const key = this.extractKeyFromUrl(fileUrl);

    try {
      await this.requireClient().send(
        new DeleteObjectCommand({
          Bucket: this.requireBucket(),
          Key: key,
        }),
      );
      this.logger.log(`File deleted successfully: ${key}`);
    } catch (error) {
      this.logger.error(`Error deleting file from S3: ${key}`, error);
      throw error;
    }
  }

  private extractKeyFromUrl(fileUrl: string): string {
    return decodeObjectKey(new URL(fileUrl).pathname.replace(/^\/+/, ''));
  }

  private publicHost(): string {
    return `${this.bucketName}.s3.${this.region}.amazonaws.com`;
  }

  private urlFor(key: string): string {
    return `https://${this.publicHost()}/${key}`;
  }

  private requireBucket(): string {
    if (!this.bucketName) {
      throw new ServiceUnavailableException({
        code: 'STORAGE_NOT_CONFIGURED',
        message: 'S3 storage is not configured: set AWS_S3_BUCKET',
      });
    }

    return this.bucketName;
  }

  private requireClient(): S3Client {
    this.client ??= new S3Client({
      region: this.region,
      credentials: {
        accessKeyId: this.env.get('AWS_ACCESS_KEY_ID') ?? '',
        secretAccessKey: this.env.get('AWS_SECRET_ACCESS_KEY') ?? '',
      },
    });

    return this.client;
  }
}
