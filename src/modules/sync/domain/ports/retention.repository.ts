/**
 * A execução da política de §14.6 — o único port do sistema cujo efeito é
 * **irreversível**.
 *
 * Está separado de `MetricPartitionsRepositoryInterface` de propósito: aquele
 * cria partições e é idempotente por `IF NOT EXISTS`; este apaga. Fundir os dois
 * poria criação e destruição atrás da mesma injeção, e a próxima chamada
 * distraída dropa em vez de criar.
 */

export type RetentionOutcome = {
  /** Partições de `ad_metric_snapshots` removidas nesta passada. */
  droppedPartitions: string[];
  /** Linhas de `ad_scores` removidas pela amostragem semanal. */
  sampledScoreRows: number;
  /** Linhas de `sync_operations` purgadas. */
  purgedSyncOperations: number;
  /** Gerações de copy expurgadas — D5. */
  purgedCopyGenerations: number;
};

export abstract class RetentionRepositoryInterface {
  /** Os nomes das partições mensais existentes hoje. */
  abstract listMetricPartitions(): Promise<string[]>;

  /**
   * `DROP TABLE` da partição — DDL, não `DELETE`.
   *
   * Apagar 15 milhões de linhas por mês com `DELETE` geraria bloat e um
   * autovacuum competindo com o ingest da madrugada. Dropar a partição devolve
   * o espaço ao sistema operacional na hora.
   */
  abstract dropMetricPartition(name: string): Promise<void>;

  /**
   * Amostragem semanal de `ad_scores` acima do corte.
   *
   * Preserva uma linha por semana por anúncio e remove o resto. Devolve quantas
   * saíram — zero é o caso normal depois da primeira passada.
   */
  abstract sampleAdScores(input: {
    cutoff: Date;
    keepWeekday: number;
    limit: number;
  }): Promise<number>;

  /** Purga de `sync_operations` acima do corte, em lote. */
  abstract purgeSyncOperations(input: {
    cutoff: Date;
    limit: number;
  }): Promise<number>;

  /**
   * D5 — expurgo do conteúdo gerado no Copy Studio.
   *
   * **Duas condições, e a segunda é o ponto.** O prazo (`retention_until`
   * vencido) não basta: a poda só alcança organização **fora de dia com a
   * cobrança**. Enquanto o cliente está ativo, o texto que ele pediu e publicou
   * é ativo dele, e apagá-lo por idade seria destruir o histórico que justifica
   * a decisão que ele tomou.
   *
   * Enquanto a conta está bloqueada e dentro do prazo, o conteúdo continua
   * existindo e fica **inacessível** — quem barra a leitura é o guard da rota,
   * não esta poda. É essa distinção que dá ao cliente a chance de regularizar
   * sem perder o que produziu.
   *
   * `copy_variants` sai junto por `ON DELETE CASCADE`: o texto mora lá, e uma
   * geração órfã de variantes guardaria o contexto de um conteúdo que já não
   * existe.
   */
  abstract purgeCopyContent(input: {
    now: Date;
    limit: number;
  }): Promise<number>;
}
