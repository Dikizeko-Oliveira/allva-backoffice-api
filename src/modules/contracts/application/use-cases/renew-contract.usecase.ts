import { Injectable, NotFoundException } from '@nestjs/common';
import { PlatformRoleService } from 'src/modules/accounts/application/services/platform-role.service';
import { AuditLogService } from 'src/modules/audit/application/audit-log.service';
import {
  EnterpriseContract,
  type NegotiatedLimits,
} from 'src/modules/contracts/domain/entities';
import { EnterpriseContractsRepositoryInterface } from 'src/modules/contracts/domain/ports/enterprise-contracts.repository';
import { ContractOutputDto } from '../dtos';
import { toContractOutput } from '../contract.presenter';

export type RenewContractInput = {
  contractId: string;
  startsAt: Date;
  endsAt: Date;
  signedAt: Date;
  signedDocumentUrl?: string | null;
  billingAmount?: number;
  gracePeriodDays?: number;
  autoRenew?: boolean;
  limits?: NegotiatedLimits;
};

/**
 * `POST /admin/contracts/:id/renew` — a vigência seguinte.
 *
 * ## Nasce assinado, e não ativo
 *
 * O sucessor entra em `SIGNED` com a vigência negociada, e o operador o ativa
 * quando quiser — normalmente logo, porque ativar antes da data não abre nada:
 * `selectGoverningContract` continua respondendo pelo contrato em vigor até a
 * virada. É essa separação que faz a renovação assinada com meses de
 * antecedência não tirar o acesso de quem renovou cedo.
 *
 * ## O anterior sobrevive à assinatura
 *
 * Ele só vira `RENEWED` quando a vigência dele termina, e quem faz isso é o job
 * de ciclo de vida. Encerrá-lo aqui seria o mesmo erro pela porta dos fundos:
 * um contrato morto some da leitura de acesso, e o cliente ficaria sem nenhum
 * vigente no intervalo entre assinar e começar.
 */
@Injectable()
export class RenewContractUseCase {
  constructor(
    private readonly contracts: EnterpriseContractsRepositoryInterface,
    private readonly platformRole: PlatformRoleService,
    private readonly auditLog: AuditLogService,
  ) {}

  async execute(
    input: RenewContractInput,
    actorId: string,
  ): Promise<ContractOutputDto> {
    await this.platformRole.assertPermission(actorId, 'billing:manage');

    const current = await this.load(input.contractId);

    const next = current.renewInto({
      contractNumber: await this.contracts.nextContractNumber(
        input.startsAt.getFullYear(),
      ),
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      signedAt: input.signedAt,
      signedDocumentUrl: input.signedDocumentUrl ?? null,
      billingAmount: input.billingAmount,
      gracePeriodDays: input.gracePeriodDays,
      autoRenew: input.autoRenew,
      limits: input.limits,
    });

    await this.contracts.save(next);

    await this.auditLog.record({
      event: 'contract.renewed',
      entityType: 'enterprise_contract',
      entityId: next.id,
      organizationId: next.organizationId,
      actorId,
      metadata: {
        renewedFrom: current.id,
        renewedFromNumber: current.contractNumber,
        contractNumber: next.contractNumber,
        startsAt: next.startsAt.toISOString(),
        endsAt: next.endsAt.toISOString(),
        billingAmount: next.billingAmount,
      },
    });

    return toContractOutput(next);
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
