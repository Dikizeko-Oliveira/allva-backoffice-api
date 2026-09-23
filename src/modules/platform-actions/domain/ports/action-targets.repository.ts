import type { AdSyncState } from 'src/modules/ads/domain/ad-sync-state';
import type { AdUnitKind } from 'src/modules/ads/domain/ad-unit';
import type {
  ActionLevel,
  AdStatus,
} from 'src/modules/ads/domain/platform/platform-profile';
import type { Platform } from 'src/modules/integrations/domain/entities/platform';

/**
 * O anúncio como **alvo de escrita** — não como linha de listagem.
 *
 * `ads` já tem read models ricos, e nenhum deles serve aqui: eles trazem score,
 * desperdício e procedência, e não trazem o id externo do conjunto nem o da
 * campanha, que é exatamente o que uma escrita em `ADJUST_AD_SET_BUDGET`
 * precisa. Um port próprio custa uma consulta e evita inflar o read model de
 * leitura com campos que só a escrita usa.
 */
export type ActionTargetView = {
  adId: string;
  organizationId: string;
  accountId: string;
  platform: Platform;
  adAccountId: string;
  /**
   * `null` quando a conta de anúncios ficou **sem credencial**.
   *
   * O rebind de A2-S3 preserva `ads.id` e zera a integração (P10): o anúncio
   * continua existindo e gastando, e só a escrita fica impossível. Este campo é
   * anulável para que §13.3 consiga dizer isso — enquanto o alvo inteiro era
   * descartado aqui, "conta desconectada" chegava à tela como "anúncio não
   * encontrado", que é falso e manda o usuário procurar o problema errado.
   */
  integrationId: string | null;
  /** Moeda da **conta** (M3) — a unidade em que o orçamento vai à plataforma. */
  accountCurrency: string;
  externalAccountId: string;

  externalAdId: string;
  /**
   * Anúncio ou grupo de recursos (D23). Decide que ações de nível `AD` existem
   * sobre o alvo — e, no gateway, que recurso da plataforma recebe a escrita.
   */
  unitKind: AdUnitKind;
  /**
   * O formato do criativo (`creatives.format`), `null` enquanto não lido.
   * Decide as ações que só existem para alguns formatos — CTA no display do
   * Google, título no anúncio de busca.
   */
  creativeFormat: string | null;
  observedStatus: AdStatus;
  desiredStatus: AdStatus | null;
  syncState: AdSyncState;
  version: number;

  adSet: { id: string; externalId: string } | null;
  campaign: { id: string; externalId: string };

  /** Ligado, a organização autoriza escrita; desligado, é o kill switch de §13.5. */
  actionsEnabled: boolean;
};

/**
 * O alvo com credencial — o único sobre o qual a cadeia de guardas opina.
 *
 * As guardas de P5 perguntam por consentimento **daquela integração**; sem ela
 * não há pergunta a fazer, e o caminho de escrita já recusou antes de chegar
 * aqui. O tipo é o que garante que essa ordem não se perca numa refatoração.
 */
export type ConnectedActionTarget = ActionTargetView & {
  integrationId: string;
};

export function isConnectedTarget(
  target: ActionTargetView,
): target is ConnectedActionTarget {
  return target.integrationId !== null;
}

/** Uma escrita em voo sobre um alvo — o lado de leitura de I2. */
export type InFlightWrite = {
  executionId: string;
  targetEntityType: ActionLevel;
  targetEntityId: string;
};

export abstract class ActionTargetsRepositoryInterface {
  /** `null` quando o anúncio não existe **ou não é da organização** (§16.7). */
  abstract findTarget(input: {
    organizationId: string;
    adId: string;
  }): Promise<ActionTargetView | null>;

  /**
   * As escritas em voo sobre os três alvos possíveis deste anúncio.
   *
   * Consulta única para os três níveis: perguntar um a um faria a tela emitir
   * três consultas para montar uma lista de treze ações, e a resposta ainda
   * poderia ser incoerente entre elas.
   */
  abstract findInFlightWrites(input: {
    organizationId: string;
    targets: Array<{ type: ActionLevel; id: string }>;
  }): Promise<InFlightWrite[]>;
}
