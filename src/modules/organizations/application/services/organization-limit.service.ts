import { Injectable } from '@nestjs/common';
import {
  OrganizationPlanPortInterface,
  OrganizationQuotaPortInterface,
  OrganizationsRepositoryInterface,
} from 'src/modules/organizations/domain/ports';
import type { PlanType } from 'src/modules/plans/domain/plan-catalog';
import {
  effectiveQuota,
  quotaStateFrom,
  type PlanEntitlementState,
} from 'src/modules/plans/domain/plan-entitlements';

/**
 * Quantas organizações a conta ainda pode possuir, e sob qual contrato.
 *
 * `limit` é o teto **efetivo** — o negociado quando existe, senão o do plano —,
 * e `null` significa que não há teto a aplicar: ilimitado, ou ainda não há
 * organização de referência de onde ler um contrato.
 */
export type OrganizationCreationAllowance = {
  /** O veredito, pronto para virar recusa via `planLimitRefusal`. */
  state: PlanEntitlementState;
  /** O plano da organização de referência — de quem a nova herda o contrato. */
  referencePlanType: PlanType | null;
  limit: number | null;
  used: number;
};

/**
 * O teto de organizações por conta — **uma regra, dois chamadores**.
 *
 * `CreateOrganizationUseCase` a aplicava inline, e era o único lugar onde ela
 * existia: a tela não tinha como perguntar antes de tentar, então o botão de
 * criar era mostrado a todo mundo e a recusa só chegava depois do formulário
 * preenchido. Repetir o cálculo no front resolveria a tela e criaria o problema
 * pior — Individual e Profissional incluem uma organização hoje, o Enterprise
 * cinco, e nada garantiria que as duas cópias concordassem amanhã; pior ainda,
 * o teto **negociado** não é publicado em catálogo nenhum, então a cópia do
 * front erraria justamente nos contratos que mais importam.
 *
 * Daí a extração: quem cria e quem pergunta chamam este mesmo método, e a
 * resposta da pergunta é, por construção, a decisão da escrita.
 *
 * Escopo por **posse** (`ownerId`), não por participação: quem foi convidado
 * para a organização de um terceiro não consome teto nenhum, e contá-la
 * impediria de criar a própria quem nunca criou nenhuma.
 */
@Injectable()
export class OrganizationLimitService {
  constructor(
    private readonly organizationsRepository: OrganizationsRepositoryInterface,
    private readonly organizationPlan: OrganizationPlanPortInterface,
    private readonly quotas: OrganizationQuotaPortInterface,
  ) {}

  /**
   * A primeira organização nunca consulta plano.
   *
   * Não há contrato de referência antes dela — é o cadastro, e o teste gratuito
   * nasce junto. Consultar plano aqui perguntaria a uma organização que ainda
   * não existe, e a contagem seria zero de todo modo.
   *
   * O plano consultado é o da organização **de referência** (a mais antiga): é o
   * contrato sob o qual a conta está, e usar o de qualquer outra faria a
   * resposta depender de qual delas o banco devolvesse primeiro.
   */
  async resolveForAccount(
    accountId: string,
  ): Promise<OrganizationCreationAllowance> {
    const reference =
      await this.organizationsRepository.findByOwnerId(accountId);

    if (!reference) {
      return {
        state: { allowed: true },
        referencePlanType: null,
        limit: null,
        used: 0,
      };
    }

    /**
     * Lê as duas portas que este módulo já possui, em vez de injetar
     * `PlanEntitlementService`.
     *
     * `PlansModule` importa `OrganizationsModule` para resolver o plano de uma
     * organização; a volta fecharia um ciclo de módulos, e o projeto não usa
     * `forwardRef` em lugar nenhum. A regra em si continua num lugar só —
     * `effectiveQuota` e `quotaStateFrom` são puras, e é por elas que o serviço
     * de planos passa também.
     */
    const [planType, overrides, used] = await Promise.all([
      this.organizationPlan.findPlanTypeByOrganizationId(reference.id),
      this.quotas.findOverrides(reference.id),
      this.organizationsRepository.countByOwnerId(accountId),
    ]);

    const limit = effectiveQuota(
      planType,
      'organizations',
      overrides.organizations,
    );

    return {
      state: quotaStateFrom({
        planType,
        feature: 'organizations',
        used,
        limit,
      }),
      referencePlanType: planType,
      limit,
      used,
    };
  }
}
