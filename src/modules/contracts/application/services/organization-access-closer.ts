import { Injectable } from '@nestjs/common';
import { OrganizationPlanPortInterface } from 'src/modules/organizations/domain/ports';
import { EnterpriseContractsRepositoryInterface } from 'src/modules/contracts/domain/ports/enterprise-contracts.repository';

/**
 * Fecha a assinatura da organização quando nenhum contrato a sustenta mais.
 *
 * ## Por que é preciso fechar
 *
 * A assinatura de uma organização Enterprise nasce `ACTIVE` e **sem data** — é
 * o contrato que diz até quando vale. Encerrar só o contrato deixaria essa
 * assinatura ativa e sem ninguém a limitar: o read model do entitlement traz
 * apenas contratos vivos, a organização passaria a parecer self-serve, e o
 * `ACTIVE` concederia acesso indefinidamente.
 *
 * ## Por que é preciso ser condicional
 *
 * Depois que a renovação passou a existir, uma organização tem mais de um
 * contrato ao mesmo tempo. Revogar sempre que **um** deles morre derruba o
 * cliente que acabou de renovar — cancelar o contrato do ano passado fecharia o
 * acesso que o contrato deste ano sustenta.
 *
 * ## Um lugar só
 *
 * Cancelamento e fim de vigência chegam aqui pela mesma porta. A versão
 * condicional nasceu no job de ciclo de vida e o cancelamento ficou com a
 * incondicional — foi exatamente essa assimetria que produziu o defeito. Duas
 * cópias de uma regra divergem, e a que diverge é a que ninguém observa.
 */
@Injectable()
export class OrganizationAccessCloser {
  constructor(
    private readonly contracts: EnterpriseContractsRepositoryInterface,
    private readonly organizationPlan: OrganizationPlanPortInterface,
  ) {}

  /**
   * Chamar **depois** de gravar o novo estado do contrato: a checagem pergunta
   * ao banco quem ainda está vivo, e um contrato morto que ainda não foi salvo
   * responderia por si mesmo.
   */
  async closeIfLastContract(
    organizationId: string | null,
    status: 'CANCELED' | 'EXPIRED',
  ): Promise<boolean> {
    if (!organizationId) return false;

    const stillLive =
      await this.contracts.findLiveByOrganizationId(organizationId);
    if (stillLive) return false;

    await this.organizationPlan.revokeForOrganization({
      organizationId,
      status,
    });

    return true;
  }
}
