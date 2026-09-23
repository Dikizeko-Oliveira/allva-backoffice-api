import type { OutcomeDeltaKind } from '../contracts/recommendation-catalog';

/**
 * `RecommendationOutcome` — a captura **pré-janela** de C8.
 *
 * > O passo 6 de §9.5 é o que torna P8 honesto. Reconstruir o "pré" dias depois
 * > lê dado que a plataforma já re-declarou (§8.9) — o dataset de acurácia
 * > nasceria contaminado exatamente pelo fenômeno que o produto sabe existir e
 * > mede em toda parte. **O pré é um fato do instante da aplicação; capturá-lo
 * > depois é inferi-lo.**
 *
 * É por isso que os campos `post*`, `verdict` e `measuredAt` são nullable: a
 * linha nasce incompleta, **por construção**. Se fossem `NOT NULL`, a captura no
 * apply seria literalmente impossível de escrever (⊕9).
 *
 * **A2-S6 entregou o modelo e a leitura do pré; A2-S9 fecha a janela pós.**
 */

export type PreWindowSnapshot = {
  recommendationId: string;
  adId: string;
  /** Segue a **linhagem**: recriar o anúncio não pode zerar o histórico (§3.6). */
  lineageId: string;
  organizationId: string;

  appliedAt: Date;
  windowDays: number;

  currency: string;
  baseCurrency: string;
  /**
   * M4 — as duas janelas convertidas pela **mesma** taxa, a de `appliedAt`.
   *
   * Sem fixá-la, a variação cambial entre a janela pré e a pós entra no
   * `observedDelta` como se fosse efeito da recomendação.
   */
  fxRateFixed: number;

  preSpendBase: number;
  preRevenueBase: number;
  preConversions: number;
  preAiScore: number | null;

  /** DEC-6 — declarado na geração, não escolhido na medição. */
  observedDeltaKind: OutcomeDeltaKind;
  engineVersion: string;
};

/**
 * Uma linha esperando medição, com tudo que a janela pós precisa (C4).
 *
 * `restatementWindowDays` vem da **conta** (⊕3): contas com atribuição de 28
 * dias re-declaram por 28, e medir a janela pós antes disso lê números que a
 * plataforma ainda vai reescrever.
 */
export type PendingOutcome = {
  id: string;
  recommendationId: string;
  organizationId: string;
  adId: string;
  lineageId: string;
  appliedAt: Date;
  windowDays: number;
  restatementWindowDays: number;
  currency: string;
  baseCurrency: string;
  fxRateFixed: number;
  preSpendBase: number;
  preRevenueBase: number;
  preConversions: number;
  preAiScore: number | null;
  observedDeltaKind: OutcomeDeltaKind;
  engineVersion: string;
};

/** O agregado da janela pós, lido sobre a **linhagem** e em moeda nativa. */
export type PostWindowAggregate = {
  spend: number;
  revenue: number;
  conversions: number;
  aiScore: number | null;
  /** Dias com linha na série — a cobertura da medição, não a sua duração. */
  observedDays: number;
  /** O motivo da quebra, quando houve uma dentro da janela (§12.5). */
  seriesDiscontinuity: string | null;
  /** Quantos anúncios da linhagem contribuíram: > 1 é sucessão (§3.6). */
  lineageAdCount: number;
  /** O anúncio saiu de ACTIVE por mão de terceiros dentro da janela. */
  externalStatusChange: boolean;
  /** Outras escritas bem-sucedidas sobre o mesmo anúncio na janela. */
  concurrentActions: number;
  /** A linha mais recente considerada — é o `asOf` da medição. */
  lastObservedAt: Date | null;
};

export type MeasurementWrite = {
  outcomeId: string;
  measuredAt: Date;
  postSpendBase: number;
  postRevenueBase: number;
  postConversions: number;
  postAiScore: number | null;
  observedDelta: number | null;
  verdict: string;
  confidence: number;
  confounders: unknown;
  secondaryDeltas: unknown;
  measurementVersion: string;
};

export abstract class RecommendationOutcomesRepositoryInterface {
  /** O snapshot pré, montado a partir da série e do score correntes. */
  abstract buildPreWindow(input: {
    organizationId: string;
    recommendationId: string;
    adId: string;
    /** Fonte de verdade da moeda-base é a organização, não o anúncio (R-M). */
    baseCurrency: string;
    appliedAt: Date;
    windowDays: number;
  }): Promise<Omit<
    PreWindowSnapshot,
    'observedDeltaKind' | 'engineVersion'
  > | null>;

  /**
   * As linhas cuja janela pós **e** cuja janela de re-declaração já fecharam.
   *
   * As duas, não só a primeira. §8.9 diz que a plataforma reescreve o passado
   * por `restatementWindowDays`; medir antes disso produz um número que muda
   * sozinho depois, e o dataset que autoriza automação (§20-H3) seria feito de
   * medições que ninguém pode reproduzir.
   */
  abstract listPendingMeasurement(input: {
    organizationId: string;
    now: Date;
    limit: number;
  }): Promise<PendingOutcome[]>;

  /** A janela `[appliedAt, appliedAt + windowDays)` sobre a **linhagem**. */
  abstract buildPostWindow(input: {
    organizationId: string;
    lineageId: string;
    adId: string;
    appliedAt: Date;
    windowDays: number;
  }): Promise<PostWindowAggregate>;

  abstract recordMeasurement(write: MeasurementWrite): Promise<void>;

  /**
   * `ABANDONED` — a janela fechou e a série não tem o que medir.
   *
   * Não é falha: é o desfecho honesto de uma recomendação cujo anúncio parou de
   * ser observável. Deixá-la `PENDING_MEASUREMENT` para sempre faria o
   * denominador de P8 crescer com linhas que nunca vão fechar, e a taxa de
   * acerto cairia por uma razão que não é acerto nem erro.
   */
  abstract abandon(input: {
    outcomeId: string;
    measuredAt: Date;
    reason: string;
    measurementVersion: string;
  }): Promise<void>;

  /**
   * O gate de P8 como consulta: `APPLIED` com janela pós completa e **sem**
   * outcome medido.
   *
   * Devolve os ids em vez de um booleano de propósito — um gate que só diz
   * "falhou" obriga quem investiga a reescrever a consulta para descobrir onde.
   */
  abstract findUnmeasuredApplied(organizationId: string): Promise<string[]>;
}
