/**
 * Manutenção das partições de `ad_metric_snapshots` (achado C1, gate G4).
 *
 * **Ninguém criava partições futuras.** G4 exige ≥ 3 meses à frente e §8.8 não
 * tinha o job. O primeiro ingest depois da última partição falharia com
 * `no partition of relation found` — perda total de ingestão, num erro que só
 * aparece no dia em que a última partição vence.
 *
 * A partição `DEFAULT` é rede de segurança, não solução: linha que cai nela fica
 * fora do plano de poda por partição e degrada toda consulta por data. Por isso
 * o gate exige que ela esteja **vazia**.
 */

export type PartitionMargin = {
  /** Meses cobertos à frente do mês corrente. */
  monthsAhead: number;
  /** Partições criadas nesta execução. */
  created: string[];
  /** Linhas na `DEFAULT` — qualquer valor > 0 é um alerta, não um número. */
  defaultPartitionRows: number;
};

/** O piso de G4 e o ponto em que a margem vira alerta (`PARTITION_MARGIN_LOW`). */
export const PARTITION_TARGET_MONTHS_AHEAD = 3;
export const PARTITION_MARGIN_ALERT_THRESHOLD = 2;

export abstract class MetricPartitionsRepositoryInterface {
  /**
   * Garante partições mensais até `monthsAhead` à frente. Idempotente por
   * `CREATE TABLE IF NOT EXISTS` — o job mensal roda sobre um estado já correto
   * sem tocar em nada.
   */
  abstract ensureMonthlyPartitions(
    monthsAhead: number,
  ): Promise<PartitionMargin>;
}
