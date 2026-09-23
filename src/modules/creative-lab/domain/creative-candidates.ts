import { formatDateBR } from 'src/shared/domain/formatters';

/**
 * Candidatos de substituição criativa (§11.4).
 *
 * `REPLACE_CREATIVE` recebe um `creativeId` **existente** — é a ação principal de
 * `REFRESH_FATIGUED_CREATIVE`, e sem uma fonte definida ela seria uma ação com
 * parâmetro inexistente.
 *
 * **A origem é fechada:** criativos já veiculados na conta. Geração pela Allva é
 * proibida (P1), e a superfície de upload está fora do escopo da v2.0 (D7.1).
 */

export type CreativeCandidate = {
  creativeId: string;
  contentHash: string;
  /** Como identificar o candidato na tela sem sair dela para descobrir qual é. */
  name: string | null;
  externalCreativeId: string;
  thumbnailUrl: string | null;
  /** Score médio dos anúncios em que este criativo rodou. */
  averageScore: number;
  /** Quantos anúncios sustentam esse número. */
  sampleSize: number;
  /** Ad sets em que já rodou — usado para excluir o que já saturou aqui. */
  ranInAdSetIds: string[];
  lastRanAt: Date | null;
};

export type RankedCandidate = CreativeCandidate & {
  /** 0..1 — quão diferente do criativo cansado. */
  dissimilarity: number;
  rank: number;
  /** Por que este candidato, em texto que vai para a tela. */
  rationale: string;
};

/** Quantos dias de descanso antes de um criativo poder voltar ao mesmo ad set. */
export const RECENT_RUN_COOLDOWN_DAYS = 30;

/** Nenhum candidato abaixo disto: substituir por algo pior não é substituir. */
export const MIN_CANDIDATE_SCORE = 55;

/**
 * Quantos criativos a leitura traz para a resolução escolher — **com folga**.
 *
 * ## Por que existe
 *
 * A leitura carregava **todos** os criativos da conta de anúncios, com os
 * anúncios pontuados de cada um, sem paginação. Numa conta de 5.000 anúncios
 * essa era a consulta mais pesada da requisição, e ela roda a cada análise nova
 * para escolher, no fim, três candidatos. É o custo real da análise de criativo
 * — muito acima do token da narrativa.
 *
 * ## Por que 50 e não 3
 *
 * A ordenação da leitura não pode ser a decisão final. O `rank` de
 * {@link resolveCandidates} é monótono no `averageScore` — a dissimilaridade é
 * binária e vale 1 para todo candidato que sobrevive ao filtro do próprio hash
 * —, então ordenar por score no banco entrega a mesma ordem. Mas o filtro de
 * descanso corta **depois**: um candidato que já rodou neste conjunto há menos
 * de {@link RECENT_RUN_COOLDOWN_DAYS} dias sai da lista, e ele pode estar no
 * topo.
 *
 * Com `LIMIT 3`, três candidatos em descanso produziriam `ADVISORY` — "suba um
 * criativo novo" — enquanto o quarto melhor da conta estava disponível. A folga
 * é o que torna esse caso desprezível: os 50 melhores estarem todos em descanso
 * no mesmo conjunto é possível e raro, e degrada para menos candidatos em vez
 * de para a resposta errada.
 */
export const CANDIDATE_POOL_SIZE = 50;

export type CandidateResolution =
  | { kind: 'CANDIDATES'; candidates: RankedCandidate[] }
  /**
   * Sem candidato, `REFRESH_FATIGUED_CREATIVE` vira **consultiva**: "este
   * criativo se esgotou e não há substituto na conta; suba um criativo novo na
   * plataforma". Uma recomendação com ação impossível é pior que uma sem ação.
   */
  | { kind: 'ADVISORY'; reason: string };

export function resolveCandidates(input: {
  fatiguedContentHash: string;
  targetAdSetId: string | null;
  candidates: CreativeCandidate[];
  now: Date;
  topK?: number;
}): CandidateResolution {
  const cooldownStart = new Date(input.now);
  cooldownStart.setUTCDate(
    cooldownStart.getUTCDate() - RECENT_RUN_COOLDOWN_DAYS,
  );

  const eligible = input.candidates.filter((candidate) => {
    if (candidate.contentHash === input.fatiguedContentHash) return false;
    if (candidate.averageScore < MIN_CANDIDATE_SCORE) return false;

    // Já rodou neste conjunto há pouco: o público já viu, e trocar por ele é
    // reencenar a fadiga que se quer resolver.
    const ranHereRecently =
      input.targetAdSetId !== null &&
      candidate.ranInAdSetIds.includes(input.targetAdSetId) &&
      candidate.lastRanAt !== null &&
      candidate.lastRanAt > cooldownStart;

    return !ranHereRecently;
  });

  if (eligible.length === 0) {
    return {
      kind: 'ADVISORY',
      reason:
        'Nenhum criativo da conta reúne desempenho e descanso suficientes para substituir este. Suba um criativo novo na plataforma.',
    };
  }

  const ranked = eligible
    .map((candidate) => {
      const dissimilarity = dissimilarityOf(
        input.fatiguedContentHash,
        candidate.contentHash,
      );

      return {
        ...candidate,
        dissimilarity,
        // **A dissimilaridade é o ponto** (§11.4): trocar um criativo cansado
        // por outro quase idêntico resolve o registro, não o problema. Por isso
        // ela pesa tanto quanto o desempenho, e não como desempate.
        rank: round4(
          (candidate.averageScore / 100) * 0.5 + dissimilarity * 0.5,
        ),
        rationale: rationaleFor(candidate, dissimilarity),
      };
    })
    .sort((a, b) => b.rank - a.rank)
    .slice(0, input.topK ?? 3);

  return { kind: 'CANDIDATES', candidates: ranked };
}

/**
 * Dissimilaridade entre dois `contentHash`.
 *
 * O hash é criptográfico, então **não** carrega semântica: dois criativos
 * parecidos produzem hashes completamente diferentes. O que ele responde com
 * honestidade é a pergunta binária — *é o mesmo conteúdo?* —, e é só isso que se
 * afirma aqui: 0 para idêntico, 1 para diferente.
 *
 * Similaridade real de conteúdo (embedding de imagem, texto) é do Horizonte 2.
 * Fingir um gradiente a partir de distância de Hamming entre hashes produziria
 * um número que parece medir semelhança e não mede nada.
 */
export function dissimilarityOf(
  fatiguedHash: string,
  candidateHash: string,
): number {
  return fatiguedHash === candidateHash ? 0 : 1;
}

function rationaleFor(
  candidate: CreativeCandidate,
  dissimilarity: number,
): string {
  const partes = [
    `score médio ${Math.round(candidate.averageScore)} em ${candidate.sampleSize} anúncio(s)`,
  ];

  if (dissimilarity === 1) partes.push('conteúdo diferente do criativo atual');
  if (candidate.lastRanAt) {
    partes.push(`última veiculação em ${formatDateBR(candidate.lastRanAt)}`);
  }

  return partes.join('; ');
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
