import { Injectable, Logger } from '@nestjs/common';
import { RetentionRepositoryInterface } from 'src/modules/sync/domain/ports/retention.repository';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

const PARENT_TABLE = 'ad_metric_snapshots';
const DEFAULT_PARTITION = `${PARENT_TABLE}_default`;

/**
 * Nome de partição válido: `ad_metric_snapshots_YYYY_MM` e nada mais.
 *
 * O DDL não aceita parâmetro ligado para identificador, então o nome entra na
 * string. A defesa não é escapar — é **recusar** qualquer nome que não case com
 * a forma que este código mesmo gera, antes de montar o comando.
 */
const PARTITION_NAME = /^ad_metric_snapshots_\d{4}_\d{2}$/;

@Injectable()
export class RetentionPrismaRepository extends RetentionRepositoryInterface {
  private readonly logger = new Logger(RetentionPrismaRepository.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async listMetricPartitions(): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ relname: string }>>`
      SELECT c.relname
        FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
        JOIN pg_class p ON p.oid = i.inhparent
       WHERE p.relname = ${PARENT_TABLE}
    `;

    // A `DEFAULT` **nunca** é dropada: ela é a rede de segurança de G4, e sem
    // ela um ingest que chegue sem partição de destino falha por inteiro.
    return rows
      .map((row) => row.relname)
      .filter((name) => name !== DEFAULT_PARTITION);
  }

  async dropMetricPartition(name: string): Promise<void> {
    if (!PARTITION_NAME.test(name)) {
      throw new Error(
        `retention.refused_partition_name="${name}" — só o formato gerado por este módulo é dropável`,
      );
    }

    /**
     * `DETACH` antes de `DROP`, e não `DROP` direto.
     *
     * Dropar a partição anexada mantém um lock forte sobre a tabela-pai durante
     * a remoção física dos arquivos; com `CONCURRENTLY`, o desanexo não bloqueia
     * o ingest, e o `DROP` que se segue age sobre uma tabela que já não é de
     * ninguém.
     */
    await this.prisma.$executeRawUnsafe(
      `ALTER TABLE "${PARENT_TABLE}" DETACH PARTITION "${name}" CONCURRENTLY`,
    );
    await this.prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${name}"`);

    this.logger.warn(`retention.partition_dropped ${name}`);
  }

  /**
   * Amostragem semanal: preserva a segunda-feira, remove o resto (§14.6).
   *
   * `EXTRACT(ISODOW)` em vez de contar dias desde uma origem: a semana ISO é
   * estável entre anos e não desloca quando um período tem 53 semanas — e um
   * deslocamento faria a amostra pular um mês inteiro em silêncio.
   *
   * Em lotes, e não num `DELETE` só: acima de 13 meses há milhões de linhas, e
   * uma transação única as travaria todas até o fim.
   */
  async sampleAdScores(input: {
    cutoff: Date;
    keepWeekday: number;
    limit: number;
  }): Promise<number> {
    const result = await this.prisma.$executeRaw`
      DELETE FROM ad_scores
       WHERE id IN (
         SELECT id FROM ad_scores
          WHERE score_date < ${input.cutoff}
            AND EXTRACT(ISODOW FROM score_date) <> ${input.keepWeekday}
          LIMIT ${input.limit}
       )
    `;

    return Number(result);
  }

  async purgeSyncOperations(input: {
    cutoff: Date;
    limit: number;
  }): Promise<number> {
    /**
     * `started_at` é nullable — uma operação enfileirada e nunca iniciada não o
     * tem. `COALESCE` com `window_end` cobre o caso; sem ele essas linhas nunca
     * casariam o filtro e ficariam para sempre, que é o oposto de uma purga.
     */
    const result = await this.prisma.$executeRaw`
      DELETE FROM sync_operations
       WHERE id IN (
         SELECT id FROM sync_operations
          WHERE COALESCE(started_at, window_end) < ${input.cutoff}
          LIMIT ${input.limit}
       )
    `;

    return Number(result);
  }

  /**
   * D5 — o conteúdo do Copy Studio, **só de quem está fora de dia**.
   *
   * As duas condições estão na mesma consulta de propósito. Separá-las — listar
   * organizações bloqueadas aqui, apagar ali — abriria uma janela entre a
   * leitura e a escrita em que um cliente que acabou de regularizar perderia o
   * conteúdo, e este é o tipo de efeito que não tem desfazer.
   *
   * A condição de cobrança é a **ausência** de assinatura em bom estado:
   * `TRIALING` e `ACTIVE` são exatamente os dois estados que `mapBillingToAccess`
   * traduz para `ALLOWED`, e organização sem assinatura nenhuma também está fora
   * de dia. Escrever a lista dos maus estados em vez dos bons faria um estado
   * novo de cobrança nascer com o conteúdo protegido por omissão — que é o erro
   * seguro, mas silencioso; aqui o erro seguro é explícito.
   */
  async purgeCopyContent(input: { now: Date; limit: number }): Promise<number> {
    const result = await this.prisma.$executeRaw`
      DELETE FROM copy_generations
       WHERE id IN (
         SELECT g.id
           FROM copy_generations g
          WHERE g.retention_until < ${input.now}
            AND NOT EXISTS (
              SELECT 1
                FROM organization_subscriptions s
               WHERE s.organization_id = g.organization_id
                 AND s.status IN ('TRIALING', 'ACTIVE')
            )
          LIMIT ${input.limit}
       )
    `;

    return Number(result);
  }
}
