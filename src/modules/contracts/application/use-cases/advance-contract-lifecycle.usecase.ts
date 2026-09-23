import { Injectable, Logger } from '@nestjs/common';
import { AuditLogService } from 'src/modules/audit/application/audit-log.service';
import { OrganizationAccessCloser } from '../services/organization-access-closer';
import { resolveContractAccess } from 'src/modules/subscriptions/access/domain/contract-access';
import { EnterpriseContract } from 'src/modules/contracts/domain/entities';
import {
  EnterpriseContractsRepositoryInterface,
  type ContractLifecycleRef,
} from 'src/modules/contracts/domain/ports/enterprise-contracts.repository';

export type AdvanceLifecycleResult = {
  scanned: number;
  expired: number;
  renewed: number;
  suspended: number;
};

/**
 * Grava o que a leitura já calcula.
 *
 * ## O acesso não depende dele
 *
 * `resolveContractAccess` decide na requisição: um contrato que venceu ontem à
 * noite não concede acesso hoje de manhã porque nenhum job rodou no meio. Este
 * job existe para o **status gravado** não mentir — a carteira do operador, o
 * relatório e qualquer consulta que filtre por `status` leem a coluna, não o
 * cálculo.
 *
 * ## Por que ele chama a mesma função da leitura
 *
 * A alternativa seria reimplementar a régua de inadimplência em SQL. Duas
 * implementações da mesma regra divergem — e divergir aqui significa um cliente
 * suspenso no relatório e trabalhando no produto, ou o contrário. Passando os
 * mesmos fatos por `resolveContractAccess`, a pergunta "o gravado bate com o
 * calculado?" tem uma resposta só por construção.
 *
 * ## A armadilha da expiração
 *
 * Expirar o contrato **sem** revogar a assinatura da organização devolveria o
 * acesso em vez de fechá-lo: o read model do entitlement ignora contratos
 * mortos, a organização passaria a parecer self-serve, e a
 * `OrganizationSubscription` que nasceu `ACTIVE` e sem data concederia acesso
 * para sempre. É o mesmo buraco que o cancelamento encontrou, e a revogação é
 * a mesma — só que aqui ela é condicional, porque uma renovação já ativada é
 * justamente o caso em que o acesso deve continuar.
 */
@Injectable()
export class AdvanceContractLifecycleUseCase {
  private readonly logger = new Logger(AdvanceContractLifecycleUseCase.name);

  constructor(
    private readonly contracts: EnterpriseContractsRepositoryInterface,
    private readonly accessCloser: OrganizationAccessCloser,
    private readonly auditLog: AuditLogService,
  ) {}

  async execute(input?: { limit?: number }): Promise<AdvanceLifecycleResult> {
    const limit = input?.limit ?? 200;
    const now = new Date();

    const live = await this.contracts.listLive(now, limit);
    const result: AdvanceLifecycleResult = {
      scanned: live.length,
      expired: 0,
      renewed: 0,
      suspended: 0,
    };

    for (const ref of live) {
      try {
        await this.advance(ref, now, result);
      } catch (error) {
        // Um contrato num estado inesperado não pode segurar a carteira toda.
        this.logger.warn(
          `Failed to advance contract=${ref.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (result.expired || result.renewed || result.suspended) {
      this.logger.log(
        `Contract lifecycle: scanned=${result.scanned} expired=${result.expired} renewed=${result.renewed} suspended=${result.suspended}`,
      );
    }

    return result;
  }

  private async advance(
    ref: ContractLifecycleRef,
    now: Date,
    result: AdvanceLifecycleResult,
  ): Promise<void> {
    if (now > ref.endsAt) {
      await this.close(ref, now, result);
      return;
    }

    if (ref.status !== 'ACTIVE') return;

    /**
     * A mesma função que a requisição usa, com os mesmos fatos. `GRACE_PERIOD`
     * é aviso e não suspensão: o cliente segue trabalhando enquanto o comercial
     * liga, que é o motivo de a tolerância existir.
     */
    const access = resolveContractAccess(ref, now);
    if (access !== 'PAYMENT_REQUIRED') return;

    const contract = await this.load(ref.id);
    if (!contract) return;

    contract.suspend({ reason: 'NON_PAYMENT', now });
    await this.contracts.update(contract);
    result.suspended += 1;

    await this.auditLog.record({
      event: 'contract.suspended',
      entityType: 'enterprise_contract',
      entityId: ref.id,
      organizationId: ref.organizationId,
      metadata: {
        reason: 'NON_PAYMENT',
        oldestUnpaidDueAt: ref.oldestUnpaidDueAt?.toISOString() ?? null,
        gracePeriodDays: ref.gracePeriodDays,
      },
    });
  }

  /**
   * O fim da vigência: renovado quando há sucessor, vencido quando não há.
   *
   * A distinção é o histórico comercial. `EXPIRED` num contrato que foi
   * renovado contaria que o cliente foi embora, e a cadeia que explica desde
   * quando ele é cliente ficaria com um buraco no meio.
   */
  private async close(
    ref: ContractLifecycleRef,
    now: Date,
    result: AdvanceLifecycleResult,
  ): Promise<void> {
    const contract = await this.load(ref.id);
    if (!contract) return;

    if (ref.hasSuccessor) {
      contract.markRenewed();
      result.renewed += 1;
    } else {
      contract.markExpired(now);
      result.expired += 1;
    }

    await this.contracts.update(contract);

    await this.auditLog.record({
      event: ref.hasSuccessor ? 'contract.renewed' : 'contract.expired',
      entityType: 'enterprise_contract',
      entityId: ref.id,
      organizationId: ref.organizationId,
      metadata: { endsAt: ref.endsAt.toISOString() },
    });

    await this.accessCloser.closeIfLastContract(ref.organizationId, 'EXPIRED');
  }

  private async load(id: string): Promise<EnterpriseContract | null> {
    return this.contracts.findById(id);
  }
}
