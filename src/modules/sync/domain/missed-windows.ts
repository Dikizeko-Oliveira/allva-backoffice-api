import { JobCadence, windowKeyFor } from './sync-window';

/**
 * As janelas que **deveriam** ter existido, e quais faltaram.
 *
 * ## Por que isto existe
 *
 * Todo defeito desta família tem a mesma assinatura: o job não falha, ele **não
 * acontece**. `SKIPPED` é `log`, `UPSTREAM_NOT_READY` é `log`, e "nunca rodou"
 * não é sequer um evento — ausência de linha em `job_runs` não dispara nada.
 *
 * Um cron horário executou 8 vezes em 24 horas e ninguém notou por uma semana,
 * porque cada leitura isolada dos logs mostrava execuções bem-sucedidas. A
 * pergunta que revela isso é a única que ninguém fazia: *quantas janelas
 * deveriam ter existido, e quantas existem?*
 *
 * ## Por que a comparação é por nome de job, e não por escopo
 *
 * O que quebra desta forma é o **agendador**, não uma conta. Um cron que não
 * dispara não deixa linha para escopo nenhum, e é isso que a comparação por
 * nome captura sem precisar enumerar contas, organizações e integrações — que
 * moram em outros módulos e mudam de tamanho a cada cliente novo.
 *
 * ## Por que não depende de onde o relógio mora
 *
 * A comparação é entre a cadência declarada em `SYNC_JOBS` e o que o banco tem.
 * Vale para cron em processo, para Cloud Scheduler e para o que vier depois: o
 * detector continua respondendo à mesma pergunta se o mecanismo for trocado.
 */

const MINUTE_MS = 60_000;

/** Quanto uma janela dura. `MONTHLY` não tem duração fixa e é tratado à parte. */
const CADENCE_MS: Readonly<Record<Exclude<JobCadence, 'MONTHLY'>, number>> = {
  FIVE_MINUTES: 5 * MINUTE_MS,
  HOURLY: 60 * MINUTE_MS,
  DAILY: 24 * 60 * MINUTE_MS,
};

/**
 * As chaves de janela entre `since` e `until`, **exclusive a corrente**.
 *
 * A janela em curso fica de fora de propósito: ela ainda pode ser preenchida, e
 * cobrá-la produziria um alerta a cada passagem. Uma rede de segurança que grita
 * sempre deixa de ser lida — é a mesma razão pela qual `SKIPPED` não é `warn`.
 *
 * `MONTHLY` devolve lista vazia: uma janela por mês é grossa demais para este
 * detector dizer algo útil, e um mês inteiro sem execução aparece por outros
 * meios muito antes.
 */
export function expectedWindows(
  cadence: JobCadence,
  since: Date,
  until: Date,
): string[] {
  if (cadence === 'MONTHLY') return [];

  const current = windowKeyFor(cadence, until);
  const step = CADENCE_MS[cadence];
  const keys: string[] = [];
  const seen = new Set<string>();

  for (let t = since.getTime(); t <= until.getTime(); t += step) {
    const key = windowKeyFor(cadence, new Date(t));
    if (key === current || seen.has(key)) continue;

    seen.add(key);
    keys.push(key);
  }

  return keys;
}

export type WindowGap = {
  jobName: string;
  /** Quantas janelas eram esperadas no período examinado. */
  expected: number;
  /** Quantas não têm linha nenhuma. */
  missing: number;
  /** As mais recentes que faltaram, para o log dizer *quando* parou. */
  mostRecentMissing: string[];
};

/** Quantas chaves nomear no log antes de resumir. */
const NAMED_IN_LOG = 5;

/**
 * O que faltou, dado o esperado e o que o banco tem.
 *
 * **Só conta janela sem linha alguma.** Uma janela com `SKIPPED` foi decidida —
 * o sistema olhou e recusou, e isso é informação, não falha. `FAILED` também
 * fica de fora: ela já grita por conta própria e tem retentativa. O que este
 * detector procura é o silêncio — nenhuma linha, nenhuma decisão, nenhum
 * rastro.
 */
export function gapFor(input: {
  jobName: string;
  expected: string[];
  recorded: Iterable<string>;
}): WindowGap | null {
  const recorded = new Set(input.recorded);
  const missing = input.expected.filter((key) => !recorded.has(key));

  if (missing.length === 0) return null;

  return {
    jobName: input.jobName,
    expected: input.expected.length,
    missing: missing.length,
    // As chaves são geradas do mais antigo para o mais novo; o fim da lista é o
    // que interessa a quem pergunta "desde quando isto está parado?".
    mostRecentMissing: missing.slice(-NAMED_IN_LOG),
  };
}
