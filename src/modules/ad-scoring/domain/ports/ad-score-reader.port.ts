/**
 * `AdScoreReader` — o port de LEITURA de score (D2).
 *
 * Resolve a impossibilidade lógica da primeira redação: `ads` expõe read models
 * mas não os calcula a partir de outros módulos (r.1), e `waste`/`creative-lab`
 * consomem `AdScoreView` "nunca importando serviços de `ad-scoring`" (r.2). Como
 * está, ninguém poderia publicar o `AdScoreView`.
 *
 * Um **port de leitura** preserva a intenção — não acoplar ao cálculo — sem a
 * contradição: o contrato mora em `ad-scoring`, os consumidores dependem dele, e
 * o serviço que calcula continua invisível de fora.
 *
 * Declarado em A2-S2, **implementado em A2-S4**. Nasce agora porque `ads` já
 * precisa do tipo para montar o detalhe do anúncio, e porque um contrato
 * declarado cedo é o que impede o consumidor de importar o cálculo por atalho.
 */
export type AdScoreComponentView = {
  /** Escala nativa — o número que o usuário reconhece. */
  value: number | null;
  /** 0..100 crescente — o que o composto consome. */
  normalizedValue: number | null;
  available: boolean;
  confidence: number;
  reasons: string[];
};

export type AdScoreView = {
  adId: string;
  adScoreId: string;
  aiScore: number;
  aiConfidence: number;
  componentCoverage: number;
  /** Cobertura relativa ao `PlatformProfile` — é sobre ela que os pisos incidem. */
  coverageRatio: number;
  algoVersion: string;
  scoreDate: Date;
  scoredAt: Date;
  windowDays: number;
  delta7d: number | null;
  /** Motivo, quando houver: delta e alerta não atravessam descontinuidade. */
  seriesDiscontinuity: string | null;
  /** Ad pausado/arquivado: o último score é preservado, não recalculado. */
  frozenAt: Date | null;
  components: Record<string, AdScoreComponentView>;
  /** Contexto declarado, fora do composto (ex.: saturationRisk em AD_SET). */
  context: Record<string, unknown> | null;
  narrative: string | null;
};

export type DateRange = { since: Date; until: Date };

export abstract class AdScoreReader {
  /** O score corrente de cada anúncio pedido, na versão ativa da organização. */
  abstract currentByAdIds(
    organizationId: string,
    adIds: string[],
  ): Promise<Map<string, AdScoreView>>;

  /**
   * A série por **linhagem**, não por `ad_id`: recriar o anúncio não pode
   * recomeçar o histórico de saúde do zero (§3.6).
   */
  abstract seriesByLineage(
    organizationId: string,
    lineageId: string,
    range: DateRange,
  ): Promise<AdScoreView[]>;
}

/**
 * Os pisos de §12.4, como dado.
 *
 * "Um mecanismo de confiança que nenhum consumidor consulta não protege nada" —
 * por isso a tabela vive aqui, ao lado do contrato, e é consumida por `GET /ads`
 * desde A2-S2, antes mesmo de haver score para filtrar.
 *
 * Os pisos incidem sobre `coverageRatio`, **nunca** sobre `componentCoverage`
 * (D11): com piso absoluto, um anúncio de Search — que nunca terá frequência nem
 * feedback negativo — sairia de toda ordenação e de todo alerta.
 */
export type ScoreFloor = { minConfidence: number; minCoverageRatio: number };

export const SCORE_FLOORS = {
  /** `?scoreBelow=` e `sortBy=aiScore`. */
  scoreOrdering: { minConfidence: 0.4, minCoverageRatio: 0.6 },
  /** `sortBy=scoreDelta` e `?scoreDroppedBy=`. */
  deltaOrdering: { minConfidence: 0.5, minCoverageRatio: 0.6 },
  /** Alerta `AD_SCORE_DROPPED`. */
  dropAlert: { minConfidence: 0.6, minCoverageRatio: 0.6 },
  /** A única ação que **aumenta** gasto — por isso o piso mais alto. */
  scaleWinningAd: { minConfidence: 0.7, minCoverageRatio: 0.8 },
} as const satisfies Record<string, ScoreFloor>;
