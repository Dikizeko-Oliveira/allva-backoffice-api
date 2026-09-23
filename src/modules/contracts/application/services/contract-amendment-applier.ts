import { Injectable, Logger } from '@nestjs/common';
import { AuditLogService } from 'src/modules/audit/application/audit-log.service';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import {
  ContractAmendment,
  EnterpriseContract,
  type AmendmentChanges,
} from 'src/modules/contracts/domain/entities';
import {
  AmendmentUsage,
  ContractUsageService,
} from './contract-usage.service';

/**
 * Escreve um aditivo nas três casas — ou em nenhuma.
 *
 * A cota é o que o produto lê para barrar o próximo convite; o contrato é o que
 * o comercial lê para saber o que está vigente; o aditivo é o registro do
 * antes. Gravar duas e falhar na terceira deixaria o cliente com uma cota que o
 * contrato não explica, que é o pior dos três estados — ninguém saberia qual
 * dos dois está errado.
 *
 * **Um lugar só, e não dois.** O operador aplica na hora quando a data já
 * chegou; o job aplica os datados de madrugada. A escrita é a mesma, e mantê-la
 * em duas cópias faria a de madrugada — a que ninguém observa — envelhecer
 * primeiro.
 */
@Injectable()
export class ContractAmendmentApplier {
  private readonly logger = new Logger(ContractAmendmentApplier.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly usage: ContractUsageService,
  ) {}

  async apply(
    amendment: ContractAmendment,
    contract: EnterpriseContract,
    options: { now?: Date; appliedBy: 'operator' | 'schedule' },
  ): Promise<AmendmentUsage> {
    const now = options.now ?? new Date();

    /**
     * O retrato vem **antes** da escrita: depois dela já seria o mundo que o
     * aditivo produziu, e não o que o operador tinha diante de si.
     */
    const usage = await this.usage.forChanges(
      amendment.organizationId,
      amendment.changes,
    );
    this.warnIfOverLimit(amendment, usage);

    const before: AmendmentChanges = {
      billingAmount: contract.billingAmount,
      ...contract.limits,
    };

    amendment.markApplied(before, now);
    contract.applyAmendment(amendment.changes);

    await this.write(amendment, contract);
    await this.record(amendment, options.appliedBy, usage);

    return usage;
  }

  private async write(
    amendment: ContractAmendment,
    contract: EnterpriseContract,
  ): Promise<void> {
    const limits = contract.limits;
    const previous = {
      previousBillingAmount: amendment.previous.billingAmount,
      previousMaxSeats: amendment.previous.maxSeats,
      previousMaxAdAccounts: amendment.previous.maxAdAccounts,
      previousMaxMonitoredAds: amendment.previous.maxMonitoredAds,
      previousMaxOrganizations: amendment.previous.maxOrganizations,
    };

    await this.prisma.$transaction(async (tx) => {
      await tx.organizationQuota.upsert({
        where: { organizationId: amendment.organizationId },
        update: limits,
        create: { organizationId: amendment.organizationId, ...limits },
      });

      await tx.enterpriseContract.update({
        where: { id: contract.id },
        data: { billingAmount: contract.billingAmount, ...limits },
      });

      /**
       * `upsert` porque as duas origens chegam aqui com o aditivo em estados
       * diferentes: o do operador ainda não existe no banco, o do job já foi
       * gravado como pendente. A alternativa seria cada chamador saber qual das
       * duas escritas é a sua — um detalhe de persistência vazando para quem
       * só quer aplicar um aditivo.
       */
      await tx.contractAmendment.upsert({
        where: { id: amendment.id },
        update: { appliedAt: amendment.appliedAt, ...previous },
        create: {
          id: amendment.id,
          contractId: amendment.contractId,
          organizationId: amendment.organizationId,
          number: amendment.number,
          effectiveAt: amendment.effectiveAt,
          appliedAt: amendment.appliedAt,
          reason: amendment.reason,
          ...amendment.changes,
          ...previous,
          createdBy: amendment.createdBy,
          createdAt: amendment.createdAt,
        },
      });
    });
  }

  /**
   * A organização já está acima de um teto que acabou de ser negociado.
   *
   * Não é erro: o cliente tem até a vigência para encolher, e em assentos e
   * contas de anúncio ficar acima nem tira acesso de ninguém — são portões que
   * recusam o próximo. O aviso existe por causa de `monitoredAds`, que é lido
   * por uma varredura noturna: quando alguém perguntar por que sumiram
   * anúncios da análise, a causa está aqui em vez de numa escavação.
   */
  private warnIfOverLimit(
    amendment: ContractAmendment,
    usage: AmendmentUsage,
  ): void {
    const exceeded = ContractUsageService.exceeded(usage);
    if (exceeded.length === 0) return;

    this.logger.warn(
      `contract_amendment.over_limit amendment=${amendment.number} ` +
        `dimensions=${exceeded.join(',')} usage=${JSON.stringify(usage)}`,
    );
  }

  private async record(
    amendment: ContractAmendment,
    appliedBy: 'operator' | 'schedule',
    usage: AmendmentUsage,
  ): Promise<void> {
    await this.auditLog.record({
      event: 'contract.amended',
      entityType: 'contract_amendment',
      entityId: amendment.id,
      organizationId: amendment.organizationId,
      actorId: amendment.createdBy,
      metadata: {
        contractId: amendment.contractId,
        number: amendment.number,
        appliedBy,
        changes: amendment.changes,
        previous: amendment.previous,
        usage,
        exceeds: ContractUsageService.exceeded(usage),
      },
    });
  }
}
