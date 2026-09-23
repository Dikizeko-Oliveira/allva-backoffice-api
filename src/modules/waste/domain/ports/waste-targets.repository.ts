import type { AdUnitKind } from 'src/modules/ads/domain/ad-unit';
import type { Platform } from 'src/modules/integrations/domain/entities/platform';
import type { OptimizationTarget } from 'src/modules/integrations/domain/entities/optimization-target';
import type { DataMaturity } from 'src/modules/sync/domain/data-maturity';
import type { DetectorProfile } from '../detector-profile';

/**
 * O que o ciclo de detecção precisa saber **antes** de detectar (§10.7 passos
 * 1 e 2).
 *
 * Um contrato só, como em `ad-scoring`: injetar três repositórios de outros
 * módulos faria `waste` depender do formato interno deles e quebrar a cada
 * mudança que não é sobre desperdício.
 */

export type DetectableAd = {
  id: string;
  accountId: string;
  adSetId: string | null;
  campaignId: string;
  adAccountId: string;
  platform: Platform;
  /** Anúncio ou grupo de recursos — decide a régua de comparação (D23). */
  unitKind: AdUnitKind;
  creativeId: string | null;
  /** DEC-5: entrega sobreposta é conteúdo idêntico, e o hash é o que o prova. */
  contentHash: string | null;
  /** `false` para pausado e arquivado — não há gasto futuro a interromper. */
  isDelivering: boolean;
  /**
   * O objetivo resolvido: o do conjunto, e o da campanha quando o conjunto não
   * declara meta (`resolveAdOptimization`). Decide o portão de conversão e a
   * linha de base de comparação.
   */
  optimization: OptimizationTarget;
  archivedAt: Date | null;
  currency: string;
  /** Dono: `sync`, denormalizada em `Ad.dataMaturity` (§5.4). */
  dataMaturity: DataMaturity | null;
};

export type DetectionSettings = {
  organizationId: string;
  accountId: string;
  baseCurrency: string;
  /** A janela ativa da organização (D8/DEC-11) — declarada, nunca inferida. */
  windowDays: number;

  /**
   * A janela de atribuição **da conta** (§8.2), ou `null` quando a plataforma
   * não a expõe.
   *
   * Mora aqui porque é ela que define quanto a janela julgada recua para já ter
   * assentado. É da conta e não da organização de propósito: duas contas da
   * mesma organização podem atribuir em 7 e em 28 dias, e tratá-las igual faria
   * a de 28 perder conversão retroativa sempre nas mesmas condições — o que é
   * indistinguível de desempenho ruim.
   */
  attributionWindowDays: number | null;
  activeDetectorProfileVersion: string;

  /**
   * §10.7 passo 1 — *"a conta teve sync bem-sucedido e completo nesta janela?"*
   *
   * `false` encerra o ciclo **sem detectar e sem resolver nada**. É a guarda que
   * impede uma integração fora do ar por uma noite de resolver todo o
   * desperdício aberto da organização como "condição cessou".
   */
  hasValidObservation: boolean;
  /** §8.7: conta `DEGRADED`/`UNREACHABLE` ou moeda em recomputo pausa tudo. */
  detectionAllowed: boolean;
  detectionBlockedReason: string | null;
  /** Instante da última varredura completa — vira `meta.asOf` dos achados. */
  lastSuccessfulFullSyncAt: Date | null;
};

export abstract class WasteTargetsRepositoryInterface {
  /** `null` quando a conta não existe. */
  abstract settingsForAccount(
    adAccountId: string,
  ): Promise<DetectionSettings | null>;

  /**
   * O perfil ativo da organização, com queda para o padrão global.
   *
   * Nunca lança: um perfil ilegível cai para o padrão e **declara a versão
   * padrão** — gravar `detectorProfileVersion` de um perfil que não foi aplicado
   * seria mentir na procedência do achado.
   */
  abstract profileFor(
    organizationId: string,
    version: string,
  ): Promise<DetectorProfile>;

  /**
   * Os anúncios da conta que entram no ciclo, **incluindo os arquivados**.
   *
   * Arquivado entra porque é ele que fecha item aberto como `STALE`; excluí-lo
   * deixaria o achado pendurado para sempre num anúncio que não existe mais.
   */
  abstract listDetectable(adAccountId: string): Promise<DetectableAd[]>;

  /** As contas que o cron percorre. */
  abstract listAccountsToDetect(): Promise<
    Array<{ adAccountId: string; organizationId: string }>
  >;
}
