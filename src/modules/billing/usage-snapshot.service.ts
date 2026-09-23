import { Injectable } from '@nestjs/common';
import { AnalysisScopeRepositoryInterface } from 'src/modules/analysis-scope/domain/ports/analysis-scope.repository';
import {
  rankingWindow,
  rotationCycleNights,
  splitScope,
} from 'src/modules/analysis-scope/domain/scope-split';
import { monthWindow } from 'src/modules/creative-lab/domain/month-window';
import { PlanEntitlementService } from 'src/modules/plans/application/plan-entitlement.service';
import {
  ENFORCED_FEATURE_KEYS,
  effectiveQuota,
  featureLabel,
  type QuotaFeatureKey,
} from 'src/modules/plans/domain/plan-entitlements';
import type { PlanType } from 'src/modules/plans/domain/plan-catalog';

/** Quem é o dono do dado medido: a organização, ou a conta quando não há uma. */
export type UsageOwner = { accountId: string; organizationId: string | null };

/** Uma linha da tela de assinatura: o que se consome, quanto, contra qual teto. */
export type UsageDimension = {
  key: QuotaFeatureKey;
  /** O rótulo do catálogo — a mesma frase que o card de preços mostra. */
  label: string;
  used: number;
  /** `null` é "sem teto nesta linha", nunca "ilimitado". */
  limit: number | null;
  /**
   * A guarda recusa ao bater o teto?
   *
   * Vai para a resposta porque a tela precisa da diferença: uma barra cheia que
   * bloqueia pede um botão de upgrade, e uma que só informa pede silêncio.
   * Deduzi-la no front por uma lista de chaves escrita à mão é como as duas
   * divergiriam na primeira linha nova.
   */
  enforced: boolean;
  /**
   * Quando o contador zera. `null` para o que **não** é consumo do ciclo.
   *
   * Anúncios analisados é capacidade: a régua é refeita toda madrugada e nada
   * acumula. Carimbar uma data de renovação ali ensinaria o cliente a esperar
   * uma folga que a virada do mês não traz.
   */
  resetsAt: string | null;
  /**
   * Quantos ficaram **de fora** do teto — só em `monitored-ads`.
   *
   * É o número que torna "300 de 300" honesto: sem ele a linha lê como folga
   * confortável, quando o que descreve é uma fila de 600 esperando vaga.
   */
  excluded?: number;
  /**
   * Em quantas noites a fila inteira passa pela análise — só em
   * `monitored-ads`.
   *
   * **É o que transforma um teto em promessa verificável.** Sem ele o produto
   * diz "todos os anúncios são analisados" e deixa o cliente descobrir a
   * cadência sozinho; com ele, "seus 5.000 giram em 9 noites" é uma afirmação
   * que dá para conferir — e o melhor argumento de upgrade que o packaging tem,
   * porque o mesmo inventário gira em 80 noites no plano de baixo.
   *
   * `null` quando não há ciclo a descrever: sem teto, teto pequeno demais para
   * ter faixa de rodízio, ou fila vazia.
   */
  rotationCycleNights?: number | null;
};

/**
 * O consumo do ciclo, dimensão a dimensão.
 *
 * ## O defeito que isto corrige
 *
 * A tela de assinatura media uma coisa só: achados de desperdício e
 * recomendações avulsas — produzidos pelo job da madrugada, não pelo usuário.
 * Quem passou a tarde no Creative Lab analisando anúncios e gerando variações
 * de copy abria a tela e via **zero**, com as duas cotas que de fato consumiu
 * invisíveis ali, e uma delas já recusando no teto.
 *
 * ## Toda linha daqui recusa alguma coisa
 *
 * É a regra que a tela ganhou junto com a correção. O contador de achados saiu:
 * ele era resultado do produto, não consumo do plano, e morava na tela errada —
 * a de assinatura responde "o que contratei e quanto usei". Ele já vive no
 * Overview, ao lado do desperdício aberto, que é onde a história de valor está.
 *
 * Uma barra que não corta é pior que nenhuma: ensina o usuário a esperar um
 * bloqueio que nunca vem, e gasta a confiança das que cortam de verdade.
 *
 * ## Nenhuma dimensão reconta o que outro módulo já conta
 *
 * As duas cotas mensais leem o **contador de reservas** — o mesmo número contra
 * o qual a guarda julga o próximo pedido. Anúncios analisados vem de quem
 * escreve `analysisEligibleAt`. Este serviço não consulta tabela nenhuma por
 * conta própria, e é deliberado: duas fontes para o número que o cliente lê
 * divergem, e a que erra é a que ninguém revisita. A tela dizendo "18 de 20"
 * enquanto a rota recusa a 19ª é um chamado de suporte que ninguém explica.
 *
 * ## Cada dimensão traz a própria janela
 *
 * As duas cotas do Creative Lab contam em UTC, porque é assim que as guardas
 * delas contam. Anúncios analisados não tem janela: a régua é refeita toda
 * madrugada e nada acumula.
 *
 * ## O que não está aqui
 *
 * Assentos e organizações são capacidade com tela própria e regras com sutileza
 * (um assento é participação ativa **ou** convite pendente). `ContractUsageService`
 * já registra por que ninguém deve reimplementá-las.
 */
@Injectable()
export class UsageSnapshotService {
  constructor(
    private readonly planEntitlement: PlanEntitlementService,
    private readonly analysisScope: AnalysisScopeRepositoryInterface,
  ) {}

  async dimensionsFor(
    owner: UsageOwner,
    planType: PlanType | null,
    now: Date,
  ): Promise<UsageDimension[]> {
    return Promise.all([
      this.monitoredAds(owner, planType, now),
      this.reservedQuota(owner, planType, 'creative-analyses', now),
      this.reservedQuota(owner, planType, 'copy-generation', now),
    ]);
  }

  /**
   * Anúncios que entram na análise — **a parede mais cara do plano, e a única
   * que o cliente não via**.
   *
   * A régua de 05:00 seleciona os que mais gastaram até o teto e zera o resto:
   * exatamente 300 no Individual, nem mais nem menos. O que faltava era dizer
   * isso ao cliente. Uma organização com 900 anúncios e teto de 300 lia "R$
   * 4.812 de desperdício encontrado" como se fosse o total da operação dela — e
   * era o total de um terço.
   *
   * **`excluded` viaja junto do par.** Sem ele a linha diz "300 de 300" e
   * parece folga confortável, quando o que ela descreve é uma fila. É a mesma
   * razão pela qual o resumo de upgrade já o carrega.
   *
   * Não conta nada por conta própria: `countEligible` e `countExcluded` são de
   * quem escreve `analysisEligibleAt`. Uma segunda versão do predicado aqui
   * mostraria ao cliente um número que o produto não usa.
   */
  private async monitoredAds(
    owner: UsageOwner,
    planType: PlanType | null,
    now: Date,
  ): Promise<UsageDimension> {
    if (!owner.organizationId) {
      return this.dimension({
        key: 'monitored-ads',
        used: 0,
        limit: null,
        resetsAt: null,
      });
    }

    const window = rankingWindow(now);

    const [limit, used, excluded, waiting] = await Promise.all([
      this.limitFor(owner.organizationId, planType, 'monitored-ads'),
      this.analysisScope.countEligible(owner.organizationId),
      this.analysisScope.countExcluded(owner.organizationId),
      /**
       * A fila **viva**, e não `excluded`.
       *
       * `excluded` inclui a cauda morta — pausado, sem entrega —, que o rodízio
       * nunca chama. Usá-la como denominador prometeria uma espera que não
       * existe, às vezes por uma ordem de grandeza.
       */
      this.analysisScope.countRotationQueue({
        organizationId: owner.organizationId,
        since: window.since,
        until: window.until,
      }),
    ]);

    return this.dimension({
      key: 'monitored-ads',
      used,
      limit,
      // Capacidade, não consumo: nada zera na virada do mês. A seleção é
      // refeita toda madrugada, e um anúncio que passe a gastar mais entra no
      // lugar de outro no mesmo dia.
      resetsAt: null,
      excluded,
      rotationCycleNights: rotationCycleNights(splitScope(limit), waiting),
    });
  }

  /**
   * As duas cotas mensais — **lidas do contador, não das tabelas**.
   *
   * É o que impede a tela de discordar da guarda. Contar `creative_analyses` e
   * `copy_generations` aqui daria um número parecido e nunca idêntico: o
   * contador registra autorização concedida, e é contra ele que a próxima
   * chamada será julgada. Duas fontes para o mesmo número divergem, e a que
   * erra é sempre a que ninguém revisita.
   *
   * Sem organização não há contador nem contrato — o escopo de conta cai em
   * zero, que é o que ele de fato consumiu destas duas cotas.
   */
  private async reservedQuota(
    owner: UsageOwner,
    planType: PlanType | null,
    feature: 'creative-analyses' | 'copy-generation',
    now: Date,
  ): Promise<UsageDimension> {
    const window = monthWindow(now);

    const [limit, used] = await Promise.all([
      this.limitFor(owner.organizationId, planType, feature),
      owner.organizationId
        ? this.planEntitlement.consumedIn({
            organizationId: owner.organizationId,
            feature,
            periodStart: window.since,
          })
        : 0,
    ]);

    return this.dimension({
      key: feature,
      used,
      limit,
      resetsAt: window.until,
    });
  }

  /**
   * O teto que vale: o negociado em contrato, se houver; senão o do plano.
   *
   * Escopo de conta (sem organização) não tem contrato onde negociar, então cai
   * direto no catálogo. É o mesmo `effectiveQuota` que `PlanEntitlementService`
   * usa por dentro — chamado aqui sem ele porque não há `organizationId` para
   * passar, e não porque a regra seja outra.
   */
  private async limitFor(
    organizationId: string | null,
    planType: PlanType | null,
    feature: QuotaFeatureKey,
  ): Promise<number | null> {
    if (!organizationId) return effectiveQuota(planType, feature, null);

    return this.planEntitlement.quotaFor({ organizationId, feature });
  }

  private dimension(input: {
    key: QuotaFeatureKey;
    used: number;
    limit: number | null;
    resetsAt: Date | null;
    excluded?: number;
    rotationCycleNights?: number | null;
  }): UsageDimension {
    return {
      key: input.key,
      label: featureLabel(input.key),
      used: input.used,
      limit: input.limit,
      enforced: (ENFORCED_FEATURE_KEYS as readonly string[]).includes(
        input.key,
      ),
      resetsAt: input.resetsAt?.toISOString() ?? null,
      ...(input.excluded === undefined ? {} : { excluded: input.excluded }),
      ...(input.rotationCycleNights === undefined
        ? {}
        : { rotationCycleNights: input.rotationCycleNights }),
    };
  }
}
