import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PlatformRoleService } from 'src/modules/accounts/application/services/platform-role.service';
import { EnterpriseProvisioningService } from 'src/modules/provisioning/application/enterprise-provisioning.service';
import { SalesLeadsRepositoryInterface } from 'src/modules/sales-leads/domain/ports';
import { EnterpriseContract } from 'src/modules/contracts/domain/entities';
import { EnterpriseContractsRepositoryInterface } from 'src/modules/contracts/domain/ports/enterprise-contracts.repository';

export type ActivateContractResult = {
  contractId: string;
  organizationId: string;
  status: string;
  alreadyProvisioned: boolean;
};

/**
 * `POST /admin/contracts/:id/activate` — o contrato assinado vira cliente.
 *
 * ## A ordem importa
 *
 * O agregado decide **primeiro** (`contract.activate()`), e o provisionamento
 * grava depois. Quem sabe se o acesso abre agora ou fica esperando a primeira
 * baixa é o contrato, olhando `activateOnSignature`; o provisionamento recebe
 * essa decisão pronta e a persiste junto com o resto. É o que mantém a máquina
 * de estados num lugar só, em vez de espalhá-la entre domínio e escrita.
 *
 * ## Uma transação, e idempotente
 *
 * Organização, titular, participação, configuração de ads, assinatura, cotas
 * negociadas e o carimbo no contrato entram juntos. Qualquer falha desfaz tudo.
 * E chamar duas vezes devolve a mesma organização sem duplicar nada — o que
 * importa quando a rede cai entre a resposta e quem esperava por ela.
 */
@Injectable()
export class ActivateContractUseCase {
  constructor(
    private readonly contracts: EnterpriseContractsRepositoryInterface,
    private readonly salesLeads: SalesLeadsRepositoryInterface,
    private readonly provisioning: EnterpriseProvisioningService,
    private readonly platformRole: PlatformRoleService,
  ) {}

  async execute(
    contractId: string,
    actorId: string,
  ): Promise<ActivateContractResult> {
    await this.platformRole.assertPermission(actorId, 'orgs:manage');

    const contract = await this.contracts.findById(contractId);

    if (!contract) {
      throw new NotFoundException({
        code: 'CONTRACT_NOT_FOUND',
        message: 'Contract not found',
      });
    }

    const lead = await this.salesLeads.findById(contract.salesLeadId);

    if (!lead) {
      /**
       * O contrato guarda a referência, mas razão social, titular e e-mail
       * moram no lead — é dele que sai a conta do dono. Sem ele não há quem
       * provisionar, e inventar um titular a partir do contrato produziria uma
       * organização sem dono alcançável.
       */
      throw new ConflictException({
        code: 'CONTRACT_LEAD_NOT_FOUND',
        message: 'The sales lead behind this contract no longer exists',
      });
    }

    await this.assertNoOverlappingContract(contract, lead);

    /**
     * O agregado decide, o provisionamento grava.
     *
     * `activate()` resolve o estado a partir de `activateOnSignature` e aplica
     * as guardas — não ativa um cancelado, não reativa o que já está ativo. O
     * `organizationId` não entra aqui porque ainda não existe: quem o cria é a
     * transação abaixo, e é ela que o carimba no contrato.
     */
    const now = new Date();
    contract.activate(now);

    const result = await this.provisioning.provisionForContract({
      lead,
      planId: contract.planId,
      limits: contract.limits,
      contract: {
        id: contract.id,
        status: contract.status,
        activatedAt: contract.activatedAt ?? now,
      },
    });

    // A instância em memória passa a refletir o que a transação gravou, para
    // que a resposta descreva a linha e não uma versão dela pela metade.
    contract.linkOrganization(result.organizationId);

    return {
      contractId: contract.id,
      organizationId: result.organizationId,
      status: contract.status,
      alreadyProvisioned: result.alreadyProvisioned,
    };
  }

  /**
   * Duas vigências não podem cobrir os mesmos dias na mesma organização.
   *
   * `renewInto` já recusa o sucessor que começa antes de o atual terminar, mas
   * criar um contrato avulso e ativá-lo não passava por guarda nenhuma. O
   * resultado eram dois vigentes ao mesmo tempo: a cota — que é uma linha só —
   * ficava com o que o último a ativar escreveu, e a cobrança emitiria fatura
   * pelos dois, sem que nada tivesse falhado.
   *
   * A organização pode ainda não existir. Quando existe, quem a conhece é o
   * contrato (numa renovação) ou o lead (num cliente que já foi provisionado);
   * quando não existe, não há com o que se sobrepor.
   */
  private async assertNoOverlappingContract(
    contract: EnterpriseContract,
    lead: { provisionedOrganizationId: string | null },
  ): Promise<void> {
    const organizationId =
      contract.organizationId ?? lead.provisionedOrganizationId;
    if (!organizationId) return;

    const live = await this.contracts.listLiveByOrganizationId(organizationId);

    const clashing = live.find(
      (other) => other.id !== contract.id && contract.overlaps(other),
    );

    if (!clashing) return;

    throw new ConflictException({
      code: 'CONTRACT_TERM_OVERLAPS',
      message:
        `Contract ${clashing.contractNumber} already covers part of this term ` +
        `for the same organization. Renew it or amend it instead.`,
    });
  }
}
