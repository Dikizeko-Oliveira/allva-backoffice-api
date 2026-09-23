import { Injectable, Logger } from '@nestjs/common';
import {
  RetentionRepositoryInterface,
  type RetentionOutcome,
} from 'src/modules/sync/domain/ports/retention.repository';
import {
  AD_SCORES_SAMPLE_WEEKDAY,
  keepDaysFor,
  droppablePartitions,
  retentionCutoff,
} from 'src/modules/sync/domain/retention-policy';

/** Lotes por passada. O job é mensal; não precisa esvaziar tudo de uma vez. */
const BATCH = 10_000;
const MAX_BATCHES = 20;

/**
 * A retenção de §14.6 (A2-S9, entrega 7).
 *
 * **É a única rotina do sistema cujo efeito é irreversível.** Não há desfazer
 * para `DROP PARTITION`, e é por isso que três coisas aqui são deliberadas:
 *
 * 1. **A fronteira é calculada em domínio puro** e testada sem banco. Uma
 *    partição que contém o dia do corte guarda dado dentro da janela de
 *    retenção; dropá-la apagaria o que o produto promete manter.
 * 2. **`action_executions` e `recommendation_outcomes` não são tocados.** O
 *    primeiro é trilha de auditoria de escrita em mídia paga (P5); o segundo é o
 *    dataset de acurácia de §20-H3, que mede ao longo de 90 dias. Podá-los
 *    apagaria exatamente o histórico que justifica o produto.
 * 3. **O que foi removido é registrado em `warn`.** Uma poda silenciosa é
 *    indistinguível de perda de dado quando alguém for procurar meses depois.
 */
@Injectable()
export class DataRetentionService {
  private readonly logger = new Logger(DataRetentionService.name);

  constructor(private readonly retention: RetentionRepositoryInterface) {}

  async execute(now: Date): Promise<RetentionOutcome> {
    /**
     * Os prazos vêm de `RETENTION_RULES`, **não de constantes paralelas**.
     *
     * A primeira redação lia `RETENTION_DAYS` e `SYNC_OPERATIONS_KEEP_DAYS`
     * direto, e a tabela de regras — que declara `keepDays` por tabela, com o
     * motivo — ficava decorativa. Duas fontes de verdade para o mesmo número
     * divergem no primeiro ajuste, e a que erra é a que ninguém lê: alguém
     * corrigiria a tabela documentada e a poda continuaria no prazo antigo.
     */
    const metricsCutoff = retentionCutoff(
      now,
      keepDaysFor('ad_metric_snapshots'),
    );
    const scoresCutoff = retentionCutoff(now, keepDaysFor('ad_scores'));
    const syncCutoff = retentionCutoff(now, keepDaysFor('sync_operations'));

    const droppedPartitions = await this.dropExpiredPartitions(metricsCutoff);

    const sampledScoreRows = await this.drain((limit) =>
      this.retention.sampleAdScores({
        cutoff: scoresCutoff,
        keepWeekday: AD_SCORES_SAMPLE_WEEKDAY,
        limit,
      }),
    );

    const purgedSyncOperations = await this.drain((limit) =>
      this.retention.purgeSyncOperations({ cutoff: syncCutoff, limit }),
    );

    /**
     * D5 — o conteúdo do Copy Studio.
     *
     * **Sem `retentionCutoff` aqui**, e a diferença é deliberada: as três podas
     * acima calculam a fronteira agora, contra a política de hoje. Esta compara
     * com `retention_until`, que foi carimbado em cada linha no momento da
     * criação — mudar o prazo depois não pode apagar retroativamente o que foi
     * gerado sob a promessa anterior, e é a única tabela deste job cujo conteúdo
     * foi produzido a pedido do cliente.
     */
    const purgedCopyGenerations = await this.drain((limit) =>
      this.retention.purgeCopyContent({ now, limit }),
    );

    if (
      droppedPartitions.length > 0 ||
      sampledScoreRows > 0 ||
      purgedSyncOperations > 0 ||
      purgedCopyGenerations > 0
    ) {
      this.logger.warn(
        `retention.applied partições=[${droppedPartitions.join(', ')}] ` +
          `scores_amostrados=${sampledScoreRows} sync_ops_purgadas=${purgedSyncOperations} ` +
          `copy_expurgada=${purgedCopyGenerations}`,
      );
    }

    return {
      droppedPartitions,
      sampledScoreRows,
      purgedSyncOperations,
      purgedCopyGenerations,
    };
  }

  private async dropExpiredPartitions(cutoff: Date): Promise<string[]> {
    const existing = await this.retention.listMetricPartitions();
    const droppable = droppablePartitions({ existing, cutoff });

    const dropped: string[] = [];
    for (const name of droppable) {
      try {
        await this.retention.dropMetricPartition(name);
        dropped.push(name);
      } catch (error) {
        /**
         * Falhar aqui **não** aborta o resto da retenção. As três podas são
         * independentes, e uma partição que não sai — por lock, por nome
         * recusado — não é razão para `sync_operations` crescer sem limite por
         * mais um mês.
         */
        this.logger.error(
          `retention.partition_drop_failed ${name}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return dropped;
  }

  /** Repete em lotes até esvaziar ou bater o teto da passada. */
  private async drain(
    step: (limit: number) => Promise<number>,
  ): Promise<number> {
    let total = 0;

    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const removed = await step(BATCH);
      total += removed;
      if (removed < BATCH) break;
    }

    return total;
  }
}
