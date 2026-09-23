import {
  benchmarkSegmentOf,
  type OptimizationTarget,
} from 'src/modules/integrations/domain/entities/optimization-target';

/**
 * **O que a Allva chama de anúncio** — a unidade que recebe score, detecção e
 * recomendação (P2).
 *
 * Quase sempre é o anúncio da plataforma. A exceção é o formato em que a
 * plataforma **não expõe anúncio nenhum**: no Performance Max do Google, a
 * campanha tem grupos de recursos, e é a plataforma quem combina títulos,
 * imagens e vídeos de cada grupo em peças que ninguém vê como entidade. O
 * grupo é a menor coisa com série própria, status próprio e botão de pausa —
 * então é ele a unidade.
 *
 * Declarado, e não inferido do id ou do formato do criativo, porque três
 * lugares decidem por ele: com quem a unidade se compara, que ações existem
 * sobre ela e como a tela a chama. Adivinhar em cada um produziria três
 * respostas diferentes para a mesma pergunta.
 *
 * `ASSET_GROUP` descreve a **forma** (um pacote de recursos que a plataforma
 * combina sozinha), não a plataforma — é o que mantém P6 de pé quando outro
 * formato automatizado aparecer com o mesmo desenho.
 */
export const AD_UNIT_KINDS = ['AD', 'ASSET_GROUP'] as const;

export type AdUnitKind = (typeof AD_UNIT_KINDS)[number];

export const AD_UNIT_LABELS: Record<AdUnitKind, string> = {
  AD: 'anúncio',
  ASSET_GROUP: 'grupo de recursos',
};

export function isAdUnitKind(value: unknown): value is AdUnitKind {
  return (
    typeof value === 'string' &&
    (AD_UNIT_KINDS as readonly string[]).includes(value)
  );
}

/**
 * **Com quem a unidade se compara**: os irmãos do mesmo conjunto; sem conjunto,
 * os da mesma campanha.
 *
 * O grupo de recursos pende direto da campanha, e os grupos de uma mesma
 * campanha disputam o mesmo orçamento — exatamente o papel que os anúncios de
 * um conjunto cumprem entre si. Sem esta regra, a unidade sem conjunto ficava
 * sem par nenhum, e todo detector relativo recusava por falta de comparação.
 *
 * O prefixo impede que o id de uma campanha colida com o de um conjunto: os
 * dois são UUIDs do domínio, mas nada garante que o mapa só receba um tipo.
 */
export function peerGroupKeyOf(unit: {
  adSetId: string | null;
  campaignId: string;
}): string {
  return unit.adSetId ?? `campaign:${unit.campaignId}`;
}

/**
 * **A régua da conta**: mesma unidade, mesmo objetivo, mesmo evento.
 *
 * O grupo de recursos entrega em busca, display, YouTube e Gmail de uma vez, e
 * costuma herdar a demanda de marca que a busca já capturava — o CPA dele não
 * é comparável ao de um anúncio de busca, mesmo com o mesmo evento de compra.
 * Misturá-los na mesma mediana faria um dos dois parecer desperdício por
 * definição.
 */
export function benchmarkKeyOf(unit: {
  unitKind: AdUnitKind;
  optimization: OptimizationTarget;
}): string {
  const segment = benchmarkSegmentOf(unit.optimization);
  return unit.unitKind === 'AD' ? segment : `${unit.unitKind}|${segment}`;
}
