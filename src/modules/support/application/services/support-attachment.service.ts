import { BadRequestException, Injectable } from '@nestjs/common';
import { StoragePortInterface } from 'src/shared/application/ports';
import { SupportTicketAttachment } from 'src/modules/support/domain/entities';

/** 5 MB — um print de tela, não um vídeo. Nenhum teto existia no projeto para copiar daqui. */
export const MAX_SUPPORT_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** Só imagem: é isso que o Drawer promete — "envie um print do problema". */
export const ALLOWED_SUPPORT_ATTACHMENT_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

/**
 * Validação e upload do print opcional de um chamado, separados de
 * `SendSupportMessageUseCase` pelo mesmo motivo que `SupportTicketNotifierService`
 * já vive fora dele: "este arquivo pode virar anexo" não é a mesma pergunta
 * que "este chamado pode existir".
 *
 * Reaproveita `StoragePortInterface` — o mesmo usado por
 * `UploadAccountAvatarUseCase` para o avatar de conta — em vez de inventar um
 * segundo caminho de upload. O objeto lido por `SendSupportMessageUseCase`
 * nunca toca a chave ou o provedor: só o que a entidade `SupportTicket`
 * precisa para nascer com ou sem anexo.
 */
/**
 * Validade da URL de leitura que a tela recebe.
 *
 * Uma hora: cobre quem deixa o chamado aberto e volta depois do café, e é
 * curta o bastante para um link copiado da tela não virar acesso duradouro ao
 * bucket. Distinta dos três dias do e-mail (`SupportTicketNotifierService`),
 * porque lá não existe como pedir outra — aqui, cada leitura assina de novo.
 */
const READ_URL_TTL_SECONDS = 60 * 60;

@Injectable()
export class SupportAttachmentService {
  constructor(private readonly storage: StoragePortInterface) {}

  /** Sem arquivo, nada a validar — o anexo é opcional. */
  validate(file: Express.Multer.File | undefined): void {
    if (!file) return;

    if (
      !ALLOWED_SUPPORT_ATTACHMENT_MIME_TYPES.includes(
        file.mimetype as (typeof ALLOWED_SUPPORT_ATTACHMENT_MIME_TYPES)[number],
      )
    ) {
      throw new BadRequestException({
        code: 'INVALID_ATTACHMENT_TYPE',
        message: `Attachment must be one of: ${ALLOWED_SUPPORT_ATTACHMENT_MIME_TYPES.join(', ')}`,
      });
    }

    if (file.size > MAX_SUPPORT_ATTACHMENT_BYTES) {
      throw new BadRequestException({
        code: 'ATTACHMENT_TOO_LARGE',
        message: `Attachment must be at most ${MAX_SUPPORT_ATTACHMENT_BYTES} bytes`,
      });
    }
  }

  /**
   * `folder` leva o `organizationId`: `buildObjectKey` não namespacia por
   * organização sozinho, e sem isso os prints de todo cliente cairiam na
   * mesma pasta do bucket.
   */
  async upload(
    file: Express.Multer.File,
    organizationId: string,
  ): Promise<SupportTicketAttachment> {
    const { url, key } = await this.storage.upload(
      file.buffer,
      file.originalname,
      file.mimetype,
      `support-tickets/${organizationId}`,
    );

    return {
      url,
      key,
      storageProvider: this.storage.provider,
      filename: file.originalname,
    };
  }

  /**
   * URLs de leitura assinadas, em lote, para as URLs gravadas.
   *
   * O bucket é privado: a URL guardada no banco é a permanente, e servida
   * crua ela responde 403. As rotas de detalhe devolviam exatamente essa —
   * o link do print aparecia na tela e não abria. `getReadUrl` é o que o
   * e-mail de suporte já usava; aqui ele passa a valer também para a tela.
   *
   * Em paralelo e deduplicado: a primeira mensagem de um chamado carrega o
   * mesmo arquivo do chamado, e assinar duas vezes a mesma URL é trabalho à
   * toa. Uma falha de assinatura não derruba a leitura do chamado — a URL
   * fica fora do mapa, e quem apresenta mostra o nome sem link.
   */
  async signReadUrls(
    urls: readonly (string | null | undefined)[],
  ): Promise<Map<string, string>> {
    const unique = [...new Set(urls.filter((url): url is string => !!url))];

    const signed = await Promise.all(
      unique.map(async (url) => {
        try {
          return [
            url,
            await this.storage.getReadUrl(url, READ_URL_TTL_SECONDS),
          ] as const;
        } catch {
          return null;
        }
      }),
    );

    return new Map(signed.filter((entry) => entry !== null));
  }
}
