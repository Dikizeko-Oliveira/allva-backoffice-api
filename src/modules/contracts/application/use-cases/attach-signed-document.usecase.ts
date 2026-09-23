import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PlatformRoleService } from 'src/modules/accounts/application/services/platform-role.service';
import { AuditLogService } from 'src/modules/audit/application/audit-log.service';
import {
  ContractTransitionError,
  EnterpriseContract,
} from 'src/modules/contracts/domain/entities';
import { EnterpriseContractsRepositoryInterface } from 'src/modules/contracts/domain/ports/enterprise-contracts.repository';
import { StoragePortInterface } from 'src/shared/application/ports';
import { ContractOutputDto } from '../dtos';
import { toContractOutput } from '../contract.presenter';

/**
 * 20 MB. Um contrato Enterprise escaneado com anexos passa fácil dos 5 MB do
 * print de suporte; acima disso já é o PDF errado (um dossiê inteiro).
 */
export const MAX_SIGNED_DOCUMENT_BYTES = 20 * 1024 * 1024;

const PDF_MIME_TYPE = 'application/pdf';

/** Todo PDF começa assim. O `mimetype` do multipart é o que o browser disse. */
const PDF_MAGIC = Buffer.from('%PDF-');

export type SignedDocumentFile = {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
};

/**
 * `POST /admin/contracts/:id/signed-document` — o PDF assinado, guardado no
 * bucket da Allva.
 *
 * ## Por que aqui, e não no backoffice
 *
 * O documento assinado é a prova do que o cliente contratou — pela régua de
 * `docs/backoffice-api.md`, é dado do produto. A coluna já morava aqui
 * (`signed_document_url`); o que faltava era onde guardar o arquivo, e a web
 * vinha guardando na memória do servidor Next, que some a cada deploy.
 *
 * ## O bucket é privado
 *
 * Grava a URL permanente; quem a devolve assinada é o
 * `SignedStorageUrlInterceptor`, em toda resposta. O link colado à mão
 * (`signedDocumentUrl` no create/patch) continua valendo para quem assina em
 * plataforma externa — esta rota é a alternativa, não a substituta.
 */
@Injectable()
export class AttachSignedDocumentUseCase {
  private readonly logger = new Logger(AttachSignedDocumentUseCase.name);

  constructor(
    private readonly contracts: EnterpriseContractsRepositoryInterface,
    private readonly platformRole: PlatformRoleService,
    private readonly storage: StoragePortInterface,
    private readonly auditLog: AuditLogService,
  ) {}

  async execute(
    id: string,
    file: SignedDocumentFile | undefined,
    actorId: string,
  ): Promise<ContractOutputDto> {
    await this.platformRole.assertPermission(actorId, 'billing:manage');

    this.validate(file);

    const contract = await this.load(id);

    // Recusa antes de subir: um PDF que o contrato não aceita não pode
    // sobrar no bucket.
    this.translate(() => contract.assertSignedDocumentAttachable());

    const previousUrl = contract.signedDocumentUrl;

    const { url } = await this.storage.upload(
      file.buffer,
      file.originalname,
      PDF_MIME_TYPE,
      `contracts/${contract.id}`,
    );

    try {
      this.translate(() => contract.attachSignedDocument(url));
      await this.contracts.update(contract);
    } catch (error) {
      await this.discard(url);
      throw error;
    }

    // Só antes da ativação se chega aqui com um documento anterior, e ali ele
    // foi um erro — muitas vezes o PDF de outro cliente. Mantê-lo no bucket
    // deixaria um contrato alheio acessível a quem achasse a URL.
    if (previousUrl) await this.discard(previousUrl);

    await this.auditLog.record({
      event: 'contract.signed_document.attached',
      entityType: 'enterprise_contract',
      entityId: contract.id,
      organizationId: contract.organizationId,
      actorId,
      // Sem a URL: o interceptor assina toda URL do bucket que sai numa
      // resposta, e a trilha de auditoria viraria um segundo caminho de
      // leitura do documento.
      metadata: {
        contractNumber: contract.contractNumber,
        filename: file.originalname,
        sizeBytes: file.size,
        replaced: previousUrl !== null,
      },
    });

    return toContractOutput(contract);
  }

  private validate(
    file: SignedDocumentFile | undefined,
  ): asserts file is SignedDocumentFile {
    if (!file) {
      throw new BadRequestException({
        code: 'FILE_REQUIRED',
        message: 'File is required',
      });
    }

    if (
      file.mimetype !== PDF_MIME_TYPE ||
      !file.buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)
    ) {
      throw new BadRequestException({
        code: 'INVALID_DOCUMENT_TYPE',
        message: 'Signed document must be a PDF',
      });
    }

    if (file.size > MAX_SIGNED_DOCUMENT_BYTES) {
      throw new BadRequestException({
        code: 'DOCUMENT_TOO_LARGE',
        message: `Signed document must be at most ${MAX_SIGNED_DOCUMENT_BYTES} bytes`,
      });
    }
  }

  /**
   * `ContractTransitionError` não é `DomainError`, e o filtro global o
   * responderia como 500. A recusa é de estado, então é 409.
   */
  private translate(action: () => void): void {
    try {
      action();
    } catch (error) {
      if (error instanceof ContractTransitionError) {
        throw new ConflictException({
          code: error.code,
          message: error.message,
        });
      }
      throw error;
    }
  }

  /** Só apaga o que é nosso: o anterior pode ser um link externo colado à mão. */
  private async discard(url: string): Promise<void> {
    if (!this.storage.ownsUrl(url)) return;

    try {
      await this.storage.deleteByUrl(url);
    } catch (error) {
      this.logger.warn(
        `contract.signed_document.discard_failed url=${url}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private async load(id: string): Promise<EnterpriseContract> {
    const contract = await this.contracts.findById(id);

    if (!contract) {
      throw new NotFoundException({
        code: 'CONTRACT_NOT_FOUND',
        message: 'Contract not found',
      });
    }

    return contract;
  }
}
