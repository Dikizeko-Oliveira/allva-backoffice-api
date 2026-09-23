import { tiktokDeliveryStatus } from 'src/modules/ads/domain/platform/delivery-status';
import type {
  ProviderAd,
  ProviderCreative,
} from 'src/modules/integrations/domain/ports';

/**
 * **Smart+ do TikTok** — o que a leitura pelas rotas próprias faz com o que
 * lê (D24). Funções puras: a decisão fica aqui, e o provider só busca.
 *
 * ## O que é sabido e o que não é
 *
 * Escrito a partir do SDK oficial (`tiktok/tiktok-business-api-sdk`, specs
 * `smart_plus_*_get.yml` e `smart_plus_material_report_*.yml`), **sem conta
 * real para conferir**:
 *
 * - `/smart_plus/campaign|adgroup|ad/get/` existem, filtram por `campaign_ids`,
 *   e o anúncio vem como `smart_plus_ad_id` — não `ad_id` —, com **vários**
 *   criativos em `creative_list`, textos em `ad_text_list`, chamadas em
 *   `call_to_action_list` e URLs em `landing_page_url_list`;
 * - a série diária por anúncio sai de `/smart_plus/material_report/breakdown/`,
 *   que aceita `stat_time_day` como dimensão e filtra por `smart_plus_ad_ids`;
 * - **não se sabe** se `/campaign/get/`, `/ad/get/` e o relatório `AUCTION_AD`
 *   também devolvem o Smart+, nem se `smart_plus_ad_id` é o mesmo número que o
 *   `ad_id` da rota padrão.
 *
 * ## Por isso, só lacunas — e por campanha
 *
 * A regra tem de dar o resultado certo nas três respostas possíveis:
 *
 * - **Campanha coberta** (a rota padrão devolveu anúncios dela): nada é
 *   acrescentado. Um anúncio Smart+ cujo id bate com um da rota padrão só
 *   **troca de representação** — vira pacote de recursos, com o criativo
 *   inteiro —, e a série continua vindo do relatório padrão. Um id que não bate
 *   é ignorado: pode ser o mesmo anúncio sob outro número, e somá-lo contaria o
 *   gasto duas vezes.
 * - **Campanha não coberta**: os anúncios Smart+ entram como unidades, e a
 *   série vem do relatório próprio.
 * - **Campanha ou grupo que a rota padrão não listou**: entra pelo que a rota
 *   própria devolveu.
 *
 * Decidir por anúncio, e não por campanha, seria mais simples e erraria no caso
 * que importa: ids diferentes para o mesmo anúncio somariam o gasto em dobro.
 */

/** O formato do pacote — é por ele que nenhuma ação de criativo se oferece. */
export const SMART_PLUS_FORMAT = 'SMART_PLUS';

/** O maior `page_size` de `/smart_plus/ad/get/` (as outras listagens vão a 1000). */
export const SMART_PLUS_AD_PAGE_SIZE = 100;

/**
 * Métricas do relatório próprio. `complete_payment_roas` é a única forma
 * documentada de chegar à receita ali; se a versão recusar, a leitura cai para
 * as quatro mínimas e a receita fica zero, como num anúncio sem valor.
 */
export const SMART_PLUS_REPORT_METRICS = [
  'spend',
  'impressions',
  'clicks',
  'conversion',
  'complete_payment_roas',
];
export const SMART_PLUS_REPORT_METRICS_MINIMAL = [
  'spend',
  'impressions',
  'clicks',
  'conversion',
];

export type SmartPlusCreativeNode = {
  ad_material_id?: string;
  material_operation_status?: string;
  creative_info?: {
    ad_format?: string;
    material_name?: string;
    video_info?: { video_id?: string; file_name?: string };
    image_info?: Array<{ web_uri?: string }>;
  };
};

export type SmartPlusAdNode = {
  smart_plus_ad_id?: string;
  ad_name?: string;
  adgroup_id?: string;
  campaign_id?: string;
  operation_status?: string;
  secondary_status?: string;
  creative_list?: SmartPlusCreativeNode[];
  ad_text_list?: Array<{ ad_text?: string }>;
  call_to_action_list?: Array<{ call_to_action?: string }>;
  landing_page_url_list?: Array<{ landing_page_url?: string }>;
};

export type SmartPlusGapFill<C, G> = {
  /** Campanhas e grupos que a rota padrão não listou. */
  campaigns: C[];
  adGroups: G[];
  /** Anúncios da rota padrão que passam a ser representados como pacote. */
  replacements: SmartPlusAdNode[];
  /** Anúncios que só a rota própria enxerga — e que pedem a série dela. */
  additions: SmartPlusAdNode[];
  /** Ignorados em campanha coberta, por não casarem id — o número a validar. */
  ignored: number;
};

/**
 * A regra de lacunas, sobre o que as duas rotas devolveram.
 *
 * `standardAds` é o que `/ad/get/` trouxe (id → campanha). No refresh dirigido
 * não há leitura de campanha, e quem chama passa `targeted: true`: aí todo id
 * que só a rota própria devolveu é unidade Smart+, porque só pode ter entrado
 * no domínio por ela.
 */
export function planSmartPlusGapFill<
  C extends { campaign_id: string },
  G extends { adgroup_id: string },
>(input: {
  standardCampaignIds: Set<string>;
  standardAdGroupIds: Set<string>;
  standardAds: Map<string, string>;
  smartCampaigns: C[];
  smartAdGroups: G[];
  smartAds: SmartPlusAdNode[];
  targeted?: boolean;
}): SmartPlusGapFill<C, G> {
  const coveredCampaigns = new Set(input.standardAds.values());

  const replacements: SmartPlusAdNode[] = [];
  const additions: SmartPlusAdNode[] = [];
  let ignored = 0;

  for (const ad of input.smartAds) {
    const id = ad.smart_plus_ad_id ? String(ad.smart_plus_ad_id) : null;
    if (!id || !ad.campaign_id || !ad.adgroup_id) continue;

    if (input.standardAds.has(id)) {
      replacements.push(ad);
    } else if (
      input.targeted ||
      !coveredCampaigns.has(String(ad.campaign_id))
    ) {
      additions.push(ad);
    } else {
      ignored += 1;
    }
  }

  return {
    campaigns: input.smartCampaigns.filter(
      (campaign) =>
        !input.standardCampaignIds.has(String(campaign.campaign_id)),
    ),
    adGroups: input.smartAdGroups.filter(
      (adGroup) => !input.standardAdGroupIds.has(String(adGroup.adgroup_id)),
    ),
    replacements,
    additions,
    ignored,
  };
}

/**
 * O anúncio Smart+ como unidade: um pacote de recursos que o TikTok combina
 * sozinho — a mesma forma do grupo de recursos do Performance Max, com a
 * diferença de ter grupo de anúncios.
 *
 * O id é o `smart_plus_ad_id` **sem prefixo**: se ele for o mesmo número do
 * `ad_id`, a troca de representação cai na mesma linha em vez de criar outra.
 */
export function toSmartPlusAd(node: SmartPlusAdNode): ProviderAd {
  const id = String(node.smart_plus_ad_id);

  return {
    externalAdId: id,
    adSetExternalId: String(node.adgroup_id),
    campaignExternalId: String(node.campaign_id),
    creativeExternalId: id,
    unitKind: 'ASSET_GROUP',
    name: node.ad_name ?? id,
    status: tiktokDeliveryStatus({
      operationStatus: node.operation_status,
      secondaryStatus: node.secondary_status,
    }),
    metadata: { smartPlus: true },
  };
}

/** Os vídeos do pacote, na ordem da plataforma — o primeiro vira a miniatura. */
export function smartPlusVideoIds(node: SmartPlusAdNode): string[] {
  return (node.creative_list ?? [])
    .map((creative) => creative.creative_info?.video_info?.video_id)
    .filter((id): id is string => Boolean(id));
}

/**
 * O pacote como criativo. `title` segue a convenção do TikTok no provider — o
 * nome do anúncio —, e os textos inteiros vão para `copyAssets.descriptions`,
 * onde a tela de recursos os lista.
 *
 * `imageUrl` fica nulo de propósito: a imagem do Smart+ vem como `web_uri`, uma
 * chave interna, não um endereço — entregá-la faria a tela tentar carregar algo
 * que não é URL.
 */
export function toSmartPlusCreative(
  node: SmartPlusAdNode,
  videoInfo: Map<
    string,
    { coverUrl: string | null; previewUrl: string | null }
  >,
): ProviderCreative {
  const id = String(node.smart_plus_ad_id);
  const texts = (node.ad_text_list ?? [])
    .map((item) => item.ad_text?.trim())
    .filter((text): text is string => Boolean(text));
  const callToActions = (node.call_to_action_list ?? [])
    .map((item) => item.call_to_action)
    .filter((cta): cta is string => Boolean(cta));
  const landingPages = (node.landing_page_url_list ?? [])
    .map((item) => item.landing_page_url)
    .filter((url): url is string => Boolean(url));
  const videoIds = smartPlusVideoIds(node);
  const firstVideo = videoIds[0] ? videoInfo.get(videoIds[0]) : undefined;

  return {
    externalCreativeId: id,
    name: node.ad_name ?? null,
    title: node.ad_name ?? null,
    body: texts[0] ?? null,
    callToAction: callToActions[0] ?? null,
    format: SMART_PLUS_FORMAT,
    thumbnailUrl: firstVideo?.coverUrl ?? null,
    videoUrl: firstVideo?.previewUrl ?? null,
    imageUrl: null,
    landingPageUrl: landingPages[0] ?? null,
    metadata: {
      copyAssets: {
        headlines: [],
        descriptions: texts.map((text, index) => ({
          index,
          text,
          pinnedField: null,
          performanceLabel: null,
        })),
        longHeadlines: [],
      },
      callToActions,
      landingPageUrls: landingPages,
      creativeCount: node.creative_list?.length ?? 0,
      materials: (node.creative_list ?? []).map((creative) => ({
        adMaterialId: creative.ad_material_id ?? null,
        status: creative.material_operation_status ?? null,
        adFormat: creative.creative_info?.ad_format ?? null,
        videoId: creative.creative_info?.video_info?.video_id ?? null,
      })),
    },
  };
}

/**
 * Os valores de uma linha do relatório próprio no vocabulário que `toMetric`
 * lê. A receita não vem pronta: é `complete_payment_roas × spend`. Sem o ROAS
 * na linha, fica fora — zero é o que o provider já grava para anúncio sem
 * valor, e é o que o portão de objetivo sabe tratar.
 */
export function smartPlusMetricValues(
  metrics: Record<string, string> | undefined,
): Record<string, string> {
  const values = { ...(metrics ?? {}) };
  const spend = Number(values.spend ?? 0);
  const impressions = Number(values.impressions ?? 0);
  const clicks = Number(values.clicks ?? 0);
  const roas = Number(values.complete_payment_roas);

  if (Number.isFinite(roas) && roas > 0 && spend > 0) {
    values.total_purchase_value = String(roas * spend);
  }
  // CTR (em porcentagem, como o relatório padrão) e CPC derivados: pedi-los
  // seria mais um campo para a versão recusar, e os três insumos já vêm.
  if (!values.ctr && impressions > 0) {
    values.ctr = String((clicks / impressions) * 100);
  }
  if (!values.cpc && clicks > 0) {
    values.cpc = String(spend / clicks);
  }

  return values;
}
