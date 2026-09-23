/**
 * §14.6 — a política de retenção como **dado**, não como número solto num SQL.
 *
 * Ela decide o que o produto deixa de saber, e é a única política do sistema
 * cujo efeito é irreversível: `DROP PARTITION` não tem desfazer. Estar aqui, em
 * domínio puro e testável, é o que permite verificar as fronteiras sem um banco
 * — e o que impede o próximo ajuste de virar um literal dentro de uma string de
 * DDL.
 */

/** Uma tabela sob retenção, com a política e a razão dela. */
export type RetentionRule = {
  table: string;
  keepDays: number;
  /** Como a poda acontece: DDL de partição, amostragem ou `DELETE`. */
  strategy: 'DROP_PARTITION' | 'SAMPLE' | 'DELETE';
  reason: string;
  /**
   * A condição **além do prazo** para a linha ser podável.
   *
   * Ausente na maioria: prazo vencido basta. Existe porque uma regra sem ela
   * seria lida como "toda linha morre depois de N dias", e para o conteúdo
   * gerado pelo cliente isso é falso — e falso na direção mais cara, porque a
   * poda não tem desfazer. Um arquivo que existe para ser a fonte honesta não
   * pode declarar uma política mais ampla que a real.
   */
  condition?: string;
};

/** Treze meses: doze de comparação ano a ano, mais o mês corrente. */
export const RETENTION_MONTHS = 13;
export const RETENTION_DAYS = RETENTION_MONTHS * 30;

/** §14.6 — 90 dias, com os contadores agregados preservados. */
export const SYNC_OPERATIONS_KEEP_DAYS = 90;

/**
 * D5 — quantos dias o texto gerado no Copy Studio fica preservado antes de ficar
 * **elegível** a expurgo.
 *
 * Espelha `COPY_RETENTION_DAYS` de `creative-lab`, que é quem carimba
 * `copy_generations.retention_until` na criação. Os dois existem porque as
 * perguntas são diferentes: lá se decide o prazo **daquela linha** no momento em
 * que ela nasce — e é isso que impede uma mudança de política de apagar
 * retroativamente o que foi gerado sob a promessa anterior; aqui se declara a
 * política vigente, ao lado das outras, para que ninguém precise procurá-la.
 */
export const COPY_CONTENT_KEEP_DAYS = 60;

/**
 * Acima de 13 meses, `ad_scores` fica com **uma linha por semana**.
 *
 * Uma por dia por anúncio é a granularidade que a tendência de 7 dias precisa, e
 * ela só interessa enquanto a decisão é atual. A série semanal preserva a curva
 * de longo prazo — que é o que alguém olha ao perguntar "este criativo já foi
 * bom?" — a um quinto do volume.
 */
export const AD_SCORES_SAMPLE_WEEKDAY = 1; // Segunda-feira (ISO).

export const RETENTION_RULES: readonly RetentionRule[] = [
  {
    table: 'ad_metric_snapshots',
    keepDays: RETENTION_DAYS,
    strategy: 'DROP_PARTITION',
    reason:
      'Particionada por RANGE(date) desde a criação (§14.3). A poda é DDL, não ' +
      'DELETE: apagar 15 milhões de linhas por mês com DELETE geraria bloat e ' +
      'um autovacuum que competiria com o ingest da madrugada.',
  },
  {
    table: 'ad_scores',
    keepDays: RETENTION_DAYS,
    strategy: 'SAMPLE',
    reason:
      'Amostragem semanal acima de 13 meses. A linha diária serve à tendência ' +
      'de 7 dias, que só interessa enquanto a decisão é atual; a curva de longo ' +
      'prazo sobrevive na amostra.',
  },
  {
    table: 'copy_generations',
    keepDays: COPY_CONTENT_KEEP_DAYS,
    strategy: 'DELETE',
    reason:
      'Conteúdo gerado sob pedido do cliente. Enquanto ele está em dia, o texto ' +
      'é ativo dele e não é podado: quem escolheu a variação e a publicou ' +
      'precisa poder reabrir o histórico que justifica a decisão.',
    condition:
      'Só alcança organização fora de dia com a cobrança. Enquanto a conta está ' +
      'bloqueada, o conteúdo continua EXISTINDO e fica INACESSÍVEL — quem barra ' +
      'a leitura é o EntitlementGuard da rota, que exige ALLOWED ou ' +
      'GRACE_PERIOD. Não há apagamento no bloqueio, e é essa distinção que dá ' +
      'ao cliente a chance de regularizar sem perder o que produziu.',
  },
  {
    table: 'sync_operations',
    keepDays: SYNC_OPERATIONS_KEEP_DAYS,
    strategy: 'DELETE',
    reason:
      'Uma linha por conta por hora. É diagnóstico operacional, não histórico ' +
      'do usuário: depois de 90 dias ninguém investiga uma ingestão específica.',
  },
];

/**
 * **`action_executions` não está na lista, e a ausência é a política** (§14.6).
 *
 * É trilha de auditoria de escrita em mídia paga (P5). Retenção plena: a
 * pergunta "quem mandou pausar este anúncio, e quando?" não tem prazo de
 * validade, e o volume é baixo o suficiente para que preservá-la não custe nada.
 *
 * O mesmo vale para `recommendation_outcomes`: é o dataset de P8 e o insumo de
 * §20-H3, que mede acurácia ao longo de 90 dias — podá-lo apagaria justamente o
 * histórico que autoriza (ou não) a automação.
 */
export const RETENTION_EXEMPT: readonly string[] = [
  'action_executions',
  'ad_actions',
  'recommendation_outcomes',
  'audit_logs',
  'security_audit_logs',
];

/**
 * O prazo declarado para uma tabela — **a única fonte de verdade**.
 *
 * Lança em tabela desconhecida em vez de cair num padrão: um `?? 400` silencioso
 * podaria uma tabela nova por um prazo que ninguém escolheu, e num efeito sem
 * desfazer o silêncio é o pior comportamento possível.
 */
export function keepDaysFor(table: string): number {
  const rule = RETENTION_RULES.find((candidate) => candidate.table === table);

  if (!rule) {
    throw new Error(
      `retention.unknown_table="${table}" — declare a regra em RETENTION_RULES antes de podar`,
    );
  }

  return rule.keepDays;
}

/** O primeiro dia que **fica**: tudo estritamente antes dele é podável. */
export function retentionCutoff(now: Date, keepDays: number): Date {
  const cutoff = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  cutoff.setUTCDate(cutoff.getUTCDate() - keepDays);
  return cutoff;
}

/**
 * As partições mensais que podem ser dropadas, dadas as existentes.
 *
 * **Só partições inteiramente anteriores ao corte.** Uma partição que contém o
 * dia do corte carrega dados dentro da janela de retenção, e dropá-la apagaria
 * dado que o produto promete guardar — o oposto silencioso do problema que a
 * retenção resolve.
 */
export function droppablePartitions(input: {
  /** Nomes no formato `ad_metric_snapshots_YYYY_MM`. */
  existing: string[];
  cutoff: Date;
}): string[] {
  return input.existing
    .filter((name) => {
      const parsed = parsePartitionMonth(name);
      if (!parsed) return false;

      // O mês inteiro tem de terminar antes do corte: comparamos o **primeiro
      // dia do mês seguinte** com o corte.
      const monthEnd = new Date(
        Date.UTC(parsed.year, parsed.monthIndex + 1, 1),
      );
      return monthEnd <= input.cutoff;
    })
    .sort();
}

/**
 * O nome tem de casar **inteiro**, prefixo incluído.
 *
 * Casar só o sufixo `_YYYY_MM` bastaria na prática — a lista vem de
 * `pg_inherits` sobre a tabela-pai —, e é exatamente por isso que não basta: uma
 * função que devolve "podável" para `qualquer_tabela_2020_01` é uma função cujo
 * único guarda-corpo é o chamador atual. O efeito aqui não tem desfazer.
 */
function parsePartitionMonth(
  name: string,
): { year: number; monthIndex: number } | null {
  const match = /^ad_metric_snapshots_(\d{4})_(\d{2})$/.exec(name);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;

  return { year, monthIndex: month - 1 };
}
