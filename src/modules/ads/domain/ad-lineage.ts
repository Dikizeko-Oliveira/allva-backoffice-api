import type { Platform } from 'src/modules/integrations/domain/entities/platform';
import type { AdActionType } from './platform/platform-profile';
import { requiresRecreate } from './platform/platform-profiles';
/**
 * Identidade e linhagem do anúncio (§3.6, invariante I6).
 *
 * `ad_id` identifica **um registro na plataforma**. Não identifica o anúncio
 * como *intenção publicitária*: `REPLACE_COPY`, `REPLACE_CTA`,
 * `REPLACE_CREATIVE` (onde a plataforma recria) e `DUPLICATE_AD` produzem id
 * novo — e a identidade quebraria exatamente na aplicação das recomendações
 * criativas, que são as mais valiosas do catálogo.
 *
 * Sem linhagem, a medição de impacto lê "gasto foi a zero" como sucesso
 * absoluto, quando o gasto apenas migrou para um id fora do campo de visão.
 */
export type AdLineage = {
  /** Nunca nulo. Default = o próprio `id` do anúncio. */
  lineageId: string;
  /** O anúncio de que este descende, quando houve recriação. */
  originAdId: string | null;
  /** A execução que o recriou — é ela que casa o id novo no ingest seguinte. */
  originActionExecutionId: string | null;
};

/**
 * A linhagem de um anúncio recém-descoberto: ele mesmo é a origem.
 *
 * O default no banco não substitui esta função — `DEFAULT` não pode referenciar
 * outra coluna da mesma linha em Postgres, então quem insere tem de escrever o
 * valor. É por isso que a invariante vive aqui e é testada.
 */
export function startLineage(adId: string): AdLineage {
  return { lineageId: adId, originAdId: null, originActionExecutionId: null };
}

/**
 * A linhagem de um anúncio derivado: herda a do pai, registra de onde veio.
 *
 * Herda `lineageId` do **pai**, não o id do pai: uma cadeia de três recriações
 * mantém as três sob a mesma linhagem, e a série continua inteira em vez de se
 * partir a cada troca de criativo.
 */
export function deriveLineage(input: {
  origin: AdLineage;
  originAdId: string;
  originActionExecutionId: string;
}): AdLineage {
  return {
    lineageId: input.origin.lineageId,
    originAdId: input.originAdId,
    originActionExecutionId: input.originActionExecutionId,
  };
}

export class BrokenLineageError extends Error {
  constructor(adId: string) {
    super(
      `Anúncio ${adId} sem lineageId. Todo anúncio pertence a exatamente uma linhagem (I6).`,
    );
    this.name = 'BrokenLineageError';
  }
}

/** I6, verificada na fronteira de escrita. */
export function assertLineage(ad: { id: string; lineageId?: string | null }) {
  if (!ad.lineageId) throw new BrokenLineageError(ad.id);
}

/**
 * **Suceder não é duplicar**, e a diferença decide quem herda a linhagem.
 *
 * `REPLACE_*` produz um **sucessor**: a plataforma cria a entidade nova e
 * arquiva a antiga, o gasto migra inteiro, e a série precisa continuar — sem
 * herdar a linhagem, o outcome mede o anúncio morto e lê "gasto foi a zero"
 * como sucesso absoluto, quando o gasto só saiu do campo de visão (§9.5 passo 6).
 *
 * `DUPLICATE_AD` produz um **irmão**: o original continua veiculando, e os dois
 * gastam em paralelo. Herdar a linhagem ali fundiria dois anúncios que competem
 * entre si numa série só, e toda métrica derivada passaria a somar o que o
 * produto existe para comparar.
 */
/**
 * **Suceder é exatamente `RECREATE`**, e por isso a resposta vem da estratégia
 * de mutação, não de uma lista aqui.
 *
 * A primeira redação listava as três substituições. Ela estava errada por
 * plataforma: na Meta `REPLACE_CREATIVE` edita em lugar — o `ad_id` permanece,
 * não há sucessor e não há o que herdar — enquanto no Google recria. Uma lista
 * global esperaria um sucessor que a Meta nunca produz, e a linhagem ficaria
 * aguardando um id que não vem.
 */
export function producesSuccessor(
  platform: Platform,
  actionType: AdActionType,
): boolean {
  return requiresRecreate(platform, actionType);
}
