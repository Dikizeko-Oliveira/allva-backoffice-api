import type { Platform } from 'src/modules/integrations/domain/entities/platform';

/**
 * Contexto: `Campaign` e `AdSet` (§4.2, §7.4).
 *
 * **Read-only e sem inteligência própria** (P2). Campanha e conjunto existem
 * para situar o anúncio — quem os agrupa, que orçamento herdam —, não para
 * carregar score, desperdício ou recomendação. Foi a inteligência em nível de
 * campanha do v1 que produziu a dupla contagem que a v2.0 existe para eliminar.
 */
export type CampaignView = {
  id: string;
  externalCampaignId: string;
  platform: Platform;
  name: string;
  status: string | null;
  objective: string | null;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  currency: string;
  startedAt: Date | null;
  endedAt: Date | null;
  archivedAt: Date | null;
  /** Contagem de anúncios vivos — situa, não diagnostica. */
  activeAdCount: number;
};

export type AdSetView = {
  id: string;
  campaignId: string;
  externalAdSetId: string;
  platform: Platform;
  name: string;
  status: string | null;
  optimizationGoal: string | null;
  billingEvent: string | null;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  archivedAt: Date | null;
  activeAdCount: number;
};

/**
 * Um criativo **sincronizado**, como contexto (A2-S9).
 *
 * A rota `GET /creatives` estava parqueada desde A2-S1 "até A2-S4"; A2-S4
 * entregou as regras de §11 e não a restaurou, porque a unidade de **análise**
 * mudou para o par `(Creative, Ad)`. O que ficou sem dono foi a listagem como
 * contexto — e contexto é exatamente o que `/campaigns` e `/ad-sets` são.
 *
 * **Nenhum número de desempenho aqui.** O mesmo criativo em cinco anúncios tem
 * cinco desempenhos, e uma média por criativo descreveria um anúncio que não
 * existe (§3.4). `adCount` situa; quem quer diagnóstico usa
 * `POST /ads/{id}/analyze`, que responde sobre o par.
 */
export type CreativeView = {
  id: string;
  externalCreativeId: string;
  platform: Platform;
  name: string | null;
  format: string | null;
  thumbnailUrl: string | null;
  /** Reconhece o mesmo conteúdo entre contas; não é linhagem. */
  contentHash: string | null;
  durationMs: number | null;
  archivedAt: Date | null;
  lastSyncedAt: Date;
  /** Em quantos anúncios vivos ele roda. Situa, não diagnostica. */
  adCount: number;
  /**
   * **O texto que está no ar** — contexto, como o resto deste tipo.
   *
   * Estava no banco desde sempre e não era exposto por rota nenhuma, o que
   * deixava duas coisas impossíveis na tela: mostrar o "antes e depois" de uma
   * variação de copy, e partir da copy existente para melhorá-la. É descrição
   * da peça, não número derivado — cabe aqui e não em `POST /ads/{id}/analyze`.
   */
  copy: {
    headline: string | null;
    body: string | null;
    callToAction: string | null;
    landingPageUrl: string | null;
    /**
     * **Todos** os títulos e descrições, onde a plataforma trabalha com lista
     * de assets — hoje, o anúncio de busca do Google.
     *
     * `headline` e `body` acima guardam só o primeiro de cada. A troca de copy
     * no Google é de um asset escolhido, e escolher exige ver todos. `null`
     * onde não há lista (Meta, TikTok) ou o criativo ainda não foi relido.
     */
    assets: {
      headlines: CopyAssetView[];
      descriptions: CopyAssetView[];
      /** Só no grupo de recursos do Performance Max; vazio nos demais. */
      longHeadlines: CopyAssetView[];
    } | null;
  };
};

/** Um asset de texto, na posição em que a plataforma o devolve. */
export type CopyAssetView = {
  index: number;
  text: string;
  /** Posição fixada pelo anunciante; a escrita a preserva. */
  pinnedField: string | null;
  /**
   * A classificação que a **plataforma** dá ao recurso (`BEST`, `GOOD`,
   * `LOW`, `LEARNING`, `PENDING`) — hoje, só no grupo de recursos do
   * Performance Max. Não é número derivado pela Allva, e o criativo do grupo é
   * de uma unidade só: não há média entre anúncios nela. `null` quando a
   * plataforma não classifica ou a leitura não veio.
   */
  performanceLabel: string | null;
};

export type ContextListQuery = {
  organizationId: string;
  adAccountId?: string;
  platform?: Platform;
  campaignId?: string;
  page: number;
  limit: number;
};

export type ContextPage<T> = { items: T[]; total: number };

/**
 * Listas de contexto mantêm `page`/`limit`, não cursor (§7.0.5): a ordenação é
 * estável — nome e data de criação não mudam a cada ciclo —, e é a volatilidade
 * da ordenação que torna offset errado nas listas de inteligência.
 */
export abstract class AdContextRepositoryInterface {
  abstract listCampaigns(
    query: ContextListQuery,
  ): Promise<ContextPage<CampaignView>>;

  abstract findCampaign(
    organizationId: string,
    campaignId: string,
  ): Promise<CampaignView | null>;

  abstract listAdSets(query: ContextListQuery): Promise<ContextPage<AdSetView>>;

  abstract findAdSet(
    organizationId: string,
    adSetId: string,
  ): Promise<AdSetView | null>;

  abstract listCreatives(
    query: ContextListQuery,
  ): Promise<ContextPage<CreativeView>>;

  abstract findCreative(
    organizationId: string,
    creativeId: string,
  ): Promise<CreativeView | null>;
}
