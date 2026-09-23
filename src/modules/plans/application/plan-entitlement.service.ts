import { Injectable } from '@nestjs/common';
import {
  OrganizationPlanPortInterface,
  OrganizationQuotaPortInterface,
  UsageCounterPortInterface,
} from 'src/modules/organizations/domain/ports';
import {
  type EnforcedFeatureKey,
  type QuotaFeatureKey,
  type PlanEntitlementState,
  type SummaryCadence,
  cheapestPlanWith,
  featureLabel,
  historyFloor,
  planAllows,
  planAllowsItem,
  planLabel,
  quotaStateFrom,
  effectiveQuota,
  summaryCadence,
  syncIntervalHours,
} from 'src/modules/plans/domain/plan-entitlements';

/**
 * Resolve o plano da organização e traduz o catálogo num fato que o domínio
 * julga.
 *
 * A decisão em si é pura (`planAllows`); o que este serviço faz é a parte que
 * toca banco — e a separação é a mesma que `ActionGuardEvaluatorService` já
 * pratica com as outras guardas de P5.
 *
 * **Um plano por organização, resolvido pela mesma porta que os assentos.**
 * `OrganizationPlanPortInterface` é o que `SeatLimitService` já consulta, e usar
 * a mesma é o que impede o produto de ter duas respostas para "qual é o plano
 * desta organização?" — uma para convidar gente e outra para escrever em mídia
 * paga.
 */
@Injectable()
export class PlanEntitlementService {
  constructor(
    private readonly plans: OrganizationPlanPortInterface,
    private readonly quotas: OrganizationQuotaPortInterface,
    private readonly counters: UsageCounterPortInterface,
  ) {}

  /**
   * O teto que vale para esta organização: o negociado, se houver, senão o do
   * plano.
   *
   * **É o único lugar que resolve teto**, e por isso `analysis-scope` e o vínculo
   * de conta passaram a chamar daqui em vez de `planQuota` direto. Um segundo
   * lugar respondendo a mesma pergunta é como o contrato de um cliente Enterprise
   * valeria ao vincular uma conta e não valeria na régua da madrugada — e a
   * divergência só apareceria como "sumiram anúncios da análise".
   *
   * `null` significa **sem teto numérico** nesta linha (não "ilimitado": o
   * Enterprise deixou de ter ilimitado). `undefined` do catálogo vira `null`
   * porque, para quem consome, "linha sem teto" e "não sei" pedem a mesma
   * decisão: não cortar.
   */
  async quotaFor(input: {
    organizationId: string;
    feature: QuotaFeatureKey;
  }): Promise<number | null> {
    const planType = await this.plans.findPlanTypeByOrganizationId(
      input.organizationId,
    );

    return this.resolveQuota(input.organizationId, planType, input.feature);
  }

  /**
   * O override cobre só as linhas que um contrato negocia.
   *
   * Um mapa exaustivo por chave seria pior: chave nova entraria com `undefined`
   * silencioso, e o teto negociado deixaria de valer sem nada falhar.
   */
  private async overrideFor(
    organizationId: string,
    feature: QuotaFeatureKey,
  ): Promise<number | null> {
    const NEGOTIABLE = {
      'ad-accounts': 'adAccounts',
      'monitored-ads': 'monitoredAds',
      organizations: 'organizations',
      // O "sob medida" do Enterprise na geração de copy. O catálogo publica o
      // piso (300); o número do contrato mora na tabela de cotas.
      'copy-generation': 'copyGenerations',
      // Mesma disciplina na análise por clique: piso publicado (10.000) e
      // número negociado na tabela.
      'creative-analyses': 'creativeAnalyses',
    } as const;

    const field = NEGOTIABLE[feature as keyof typeof NEGOTIABLE];
    if (!field) return null;

    return (await this.quotas.findOverrides(organizationId))[field];
  }

  private async resolveQuota(
    organizationId: string,
    planType: Parameters<typeof planLabel>[0],
    feature: QuotaFeatureKey,
  ): Promise<number | null> {
    return effectiveQuota(
      planType,
      feature,
      await this.overrideFor(organizationId, feature),
    );
  }

  /**
   * Suporte não é capacidade de produto, e por isso não morre com o acesso.
   *
   * As outras chaves perguntam "esta organização pode usar isto?", e depois de
   * uma revogação a resposta certa é não. Estas duas perguntam outra coisa: "que
   * nível de atendimento esta conta contratou?". Resolvê-las pelo plano em vigor
   * fazia o cancelamento levar junto o canal de abrir chamado - logo para quem
   * mais precisa dele, e quase sempre **sobre a própria cobrança**.
   */
  private static readonly SUPPORT_FEATURE_KEYS = new Set<EnforcedFeatureKey>([
    'support-email',
    'support-priority',
    // As leituras da Central de suporte entram pela mesma porta, e pelo mesmo
    // motivo: quem está em atraso continua podendo abrir o chamado — ler os
    // próprios chamados e o histórico da resposta é parte do mesmo canal, e
    // fechá-lo no momento da cobrança é fechá-lo exatamente para quem foi
    // cobrado.
    'support-dedicated-channel',
    'support-onboarding',
  ]);

  private async planTypeFor(
    organizationId: string,
    feature: EnforcedFeatureKey,
  ) {
    return PlanEntitlementService.SUPPORT_FEATURE_KEYS.has(feature)
      ? this.plans.findContractedPlanTypeByOrganizationId(organizationId)
      : this.plans.findPlanTypeByOrganizationId(organizationId);
  }

  async stateFor(input: {
    organizationId: string;
    feature: EnforcedFeatureKey;
  }): Promise<PlanEntitlementState> {
    const planType = await this.planTypeFor(
      input.organizationId,
      input.feature,
    );

    if (planAllows(planType, input.feature)) return { allowed: true };

    return this.denial(planType, input.feature);
  }

  /** Atalho para quem só precisa do booleano — a listagem de disponibilidade. */
  async allows(input: {
    organizationId: string;
    feature: EnforcedFeatureKey;
  }): Promise<boolean> {
    return (await this.stateFor(input)).allowed;
  }

  /**
   * O veredito de uma feature **com teto numérico**, contra o uso atual.
   *
   * `used` chega de fora porque contar é trabalho de quem tem o repositório:
   * contas de anúncios sabem contar contas, relatórios sabem contar relatórios,
   * e este serviço não deve conhecer nenhum dos dois. Ele sabe o teto.
   *
   * O `>=` é deliberado: o argumento é o uso **antes** de adicionar mais um, e
   * quem está exatamente no teto não pode adicionar.
   */
  async quotaStateFor(input: {
    organizationId: string;
    feature: EnforcedFeatureKey;
    used: number;
  }): Promise<PlanEntitlementState> {
    const planType = await this.plans.findPlanTypeByOrganizationId(
      input.organizationId,
    );

    const limit = await this.resolveQuota(
      input.organizationId,
      planType,
      input.feature,
    );

    return quotaStateFrom({
      planType,
      feature: input.feature,
      used: input.used,
      limit,
    });
  }

  /**
   * Consome uma unidade da cota mensal — **e a decisão e o efeito são um só**.
   *
   * ## Por que isto substituiu `quotaStateFor` nas cotas mensais
   *
   * `quotaStateFor` recebe o `used` de fora, contado por quem chama. Era o
   * desenho certo enquanto o que se contava eram coisas que **já existiam**
   * (contas conectadas, assentos ocupados): perguntar e agir podia ficar
   * separado porque nada estava sendo criado no meio.
   *
   * Nas cotas de consumo isso deixa uma janela. `COUNT` devolvia 99 para dois
   * pedidos simultâneos, os dois passavam pelo `99 < 100`, e o mês fechava em
   * 101 — com a tela de assinatura exibindo o furo em letras grandes. Aqui a
   * pergunta e o efeito acontecem na mesma instrução, e o segundo pedido já
   * enxerga o primeiro.
   *
   * ## Quem reserva tem de devolver
   *
   * A unidade sai do contador **antes** do trabalho. Se o trabalho não
   * acontecer — provider fora do ar, escrita que falhou —, o chamador chama
   * {@link releaseQuota}. É o preço de a cota ser exata, e é um preço que só
   * quem conhece o desfecho pode pagar: este serviço não sabe se a geração deu
   * certo.
   */
  async reserveQuota(input: {
    organizationId: string;
    feature: EnforcedFeatureKey;
    periodStart: Date;
  }): Promise<PlanEntitlementState & { used?: number; limit?: number | null }> {
    const planType = await this.plans.findPlanTypeByOrganizationId(
      input.organizationId,
    );

    const limit = await this.resolveQuota(
      input.organizationId,
      planType,
      input.feature,
    );

    const used = await this.counters.reserve({
      organizationId: input.organizationId,
      feature: input.feature,
      periodStart: input.periodStart,
      limit,
    });

    if (used !== null) return { allowed: true, used, limit };

    /**
     * A recusa reporta `used: limit`, e não o contador relido.
     *
     * Reler traria o valor de agora, que pode já ter mudado por outro pedido —
     * e a frase "você usou as 100 de 100" precisa concordar com o teto que
     * acabou de recusar, não com uma foto tirada um instante depois.
     *
     * `limit` é não-nulo aqui por construção: `reserve` só devolve `null`
     * quando havia teto para bater.
     */
    return {
      ...quotaStateFrom({
        planType,
        feature: input.feature,
        used: limit ?? 0,
        limit,
      }),
      used: limit ?? 0,
      limit,
    };
  }

  /** Devolve uma unidade reservada cujo trabalho não aconteceu. */
  async releaseQuota(input: {
    organizationId: string;
    feature: EnforcedFeatureKey;
    periodStart: Date;
  }): Promise<void> {
    await this.counters.release(input);
  }

  /**
   * Quanto já foi consumido no período — **lido do contador, não da tabela**.
   *
   * É o que impede a tela de discordar da guarda: o número que aparece na
   * barra de uso é literalmente o número contra o qual a próxima chamada será
   * julgada.
   */
  async consumedIn(input: {
    organizationId: string;
    feature: EnforcedFeatureKey;
    periodStart: Date;
  }): Promise<number> {
    return this.counters.read(input);
  }

  /**
   * O veredito de uma feature que é **subconjunto** — plataforma, modelo de
   * relatório.
   */
  async itemStateFor(input: {
    organizationId: string;
    feature: EnforcedFeatureKey;
    item: string;
  }): Promise<PlanEntitlementState> {
    const planType = await this.plans.findPlanTypeByOrganizationId(
      input.organizationId,
    );

    if (planAllowsItem(planType, input.feature, input.item)) {
      return { allowed: true };
    }

    return this.denial(planType, input.feature);
  }

  /**
   * A data mais antiga que esta organização pode ler.
   *
   * `null` é "sem piso" — plano ilimitado ou organização irresolúvel. **Abre na
   * dúvida**, ao contrário de `planAllows`: cortar histórico por não saber o
   * plano faria a tela mostrar uma série truncada como se fosse a série real, e
   * o usuário concluiria coisas erradas sobre a própria mídia. O erro do lado
   * permissivo aqui é uma leitura a mais; do outro lado, é um número errado.
   */
  async historyFloorFor(organizationId: string): Promise<Date | null> {
    const planType =
      await this.plans.findPlanTypeByOrganizationId(organizationId);

    return historyFloor(planType);
  }

  /** Diário ou semanal — a cadência do resumo por email desta organização. */
  async summaryCadenceFor(organizationId: string): Promise<SummaryCadence> {
    const planType =
      await this.plans.findPlanTypeByOrganizationId(organizationId);

    return summaryCadence(planType);
  }

  /** Intervalo mínimo, em horas, entre ingestões desta organização. */
  async syncIntervalHoursFor(organizationId: string): Promise<number> {
    const planType =
      await this.plans.findPlanTypeByOrganizationId(organizationId);

    return syncIntervalHours(planType);
  }

  private denial(
    planType: Parameters<typeof planLabel>[0],
    feature: EnforcedFeatureKey,
  ): Extract<PlanEntitlementState, { allowed: false }> {
    return {
      allowed: false,
      planLabel: planLabel(planType),
      featureLabel: featureLabel(feature),
      upgradeTo: cheapestPlanWith(feature),
    };
  }
}
