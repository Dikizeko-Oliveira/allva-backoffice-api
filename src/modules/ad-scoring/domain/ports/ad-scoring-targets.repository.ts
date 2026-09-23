import type { Platform } from 'src/modules/integrations/domain/entities/platform';
import type { OptimizationTarget } from 'src/modules/integrations/domain/entities/optimization-target';

/**
 * Quem pontuar, e sob que régua (§12.5, A10/D16).
 *
 * `ad-scoring` não pode importar o repositório de `ads` para escrever, nem o de
 * `sync` para ler saúde de conta: precisa de **um** contrato com o que o cálculo
 * exige, e é este. A alternativa — injetar três repositórios de outros módulos —
 * faria o scoring depender do formato interno deles e quebrar a cada mudança que
 * não é sobre score.
 */

export type ScorableAd = {
  id: string;
  lineageId: string;
  /** Só a narrativa usa — o número nunca depende de como o anúncio se chama. */
  name: string;
  platform: Platform;
  adSetId: string | null;
  /** Os pares da unidade sem conjunto — o grupo de recursos — são os da campanha. */
  campaignId: string;
  creativeId: string | null;
  /**
   * O objetivo resolvido (conjunto, depois campanha). `audienceFit` só vale
   * para anúncio julgável por conversão: medir "aderência de conversão" num
   * anúncio de alcance é medir o que ele não buscou.
   */
  optimization: OptimizationTarget;
  /**
   * `false` para pausado e arquivado. §12.5: o último score é **preservado** com
   * `frozenAt`, e nenhum alerta de queda é gerado sobre ele — um anúncio que não
   * entrega não "piorou", ele parou.
   */
  isDelivering: boolean;
};

/**
 * A configuração por organização que o cálculo consome.
 *
 * Vem de `OrganizationAdsSettings`, nunca de constante de código — é a decisão
 * D16 inteira, e a linha existe para toda organização desde a correção de dívida
 * que precedeu A2-S4.
 */
export type ScoringSettings = {
  organizationId: string;
  scoringWindowDays: number;
  activeAlgoVersion: string;
  /** §8.7: conta `DEGRADED` ou `UNREACHABLE` **pausa o scoring**. */
  scoringAllowed: boolean;
  scoringBlockedReason: string | null;
};

export abstract class AdScoringTargetsRepositoryInterface {
  /**
   * Os anúncios da conta que entram no ciclo.
   *
   * Inclui pausados e arquivados: eles são congelados, não ignorados — pular
   * faria o último score envelhecer sem nunca declarar que parou de valer.
   */
  abstract listScorable(adAccountId: string): Promise<ScorableAd[]>;

  /** `null` quando a conta não existe. */
  abstract settingsForAccount(
    adAccountId: string,
  ): Promise<ScoringSettings | null>;

  /** As contas que o cron percorre. */
  abstract listAccountsToScore(): Promise<
    Array<{ adAccountId: string; organizationId: string }>
  >;
}
