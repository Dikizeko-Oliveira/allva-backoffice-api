/**
 * Renders `coverage/coverage-summary.json` as a Markdown table for the GitHub
 * Actions job summary (PLAN.md Sprint 5.5 / P-1).
 *
 * Prints the global totals plus each critical path that carries its own
 * threshold, so a reviewer sees which number moved without opening the log.
 * Plain node, no dependencies — this runs after `pnpm test:cov` and must not
 * fail the job on its own.
 */
const fs = require('node:fs');
const path = require('node:path');

/** Keep in sync with `coverageThreshold` in jest.config.js. */
const CRITICAL_PATHS = [
  ['ai/infrastructure/routing', 'src/modules/ai/infrastructure/routing/'],
  ['shared/infrastructure/security', 'src/shared/infrastructure/security/'],
  ['subscriptions/access/domain', 'src/modules/subscriptions/access/domain/'],
  ['shared/infrastructure/config', 'src/shared/infrastructure/config/'],
  ['modules/alerts', 'src/modules/alerts/'],
  ['modules/audit', 'src/modules/audit/'],
  // A2-S0 — infraestrutura transversal (eventos, envelope §7.0, cursor,
  // correlação). Está aqui pelo mesmo motivo das demais: é caminho crítico de
  // todos os sprints seguintes.
  ['shared/domain/events', 'src/shared/domain/events/'],
  ['shared/infrastructure/events', 'src/shared/infrastructure/events/'],
  [
    'shared/infrastructure/http/envelope',
    'src/shared/infrastructure/http/envelope/',
  ],
  [
    'shared/infrastructure/http/errors',
    'src/shared/infrastructure/http/errors/',
  ],
  [
    'shared/infrastructure/http/pagination',
    'src/shared/infrastructure/http/pagination/',
  ],
  ['shared/infrastructure/context', 'src/shared/infrastructure/context/'],
  ['currency/domain', 'src/modules/currency/domain/'],
  ['platform-clients/domain', 'src/modules/platform-clients/domain/'],
  ['sync/domain', 'src/modules/sync/domain/'],
  ['ad-scoring/domain', 'src/modules/ad-scoring/domain/'],
  /**
   * **Faltavam aqui desde A2-S5 e A2-S6**, pela mesma causa que o comentário do
   * webhook do Stripe descreve: o Jest os subtrai do pool global e este script
   * não subtraía, então o "Gated remainder" saía ~2 pontos **acima** do número
   * que o gate de fato compara — e sempre para cima, porque os dois têm
   * cobertura alta.
   *
   * Apareceu em A2-S9 ao subir a catraca: o script reportou 60,1 de statements,
   * a catraca foi cravada abaixo disso, e o Jest reprovou com 57,95. Uma
   * discrepância que só aparece quando alguém confia no número é exatamente a
   * classe de defeito que este script existe para eliminar.
   */
  ['waste/domain', 'src/modules/waste/domain/'],
  ['recommendations/domain', 'src/modules/recommendations/domain/'],
  // Grupo de arquivo único, não de diretório. Faltava aqui: como o Jest o
  // subtrai do pool global e este script não subtraía, o "Gated remainder"
  // saía ~1 ponto acima do número que o gate realmente compara — sempre para
  // cima, porque o arquivo tem cobertura quase total.
  [
    'subscriptions/handle-stripe-webhook',
    'src/modules/subscriptions/application/use-cases/handle-stripe-webhook.usecase.ts',
  ],
];

const METRICS = ['statements', 'branches', 'functions', 'lines'];

function main() {
  const summaryPath = path.join(
    __dirname,
    '..',
    '..',
    'coverage',
    'coverage-summary.json',
  );

  if (!fs.existsSync(summaryPath)) {
    process.stdout.write(
      '### Coverage\n\nNo coverage report produced (tests likely failed before instrumentation).\n',
    );
    return;
  }

  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const repoRoot = path.join(__dirname, '..', '..');

  const criticalPrefixes = CRITICAL_PATHS.map(([, relativePrefix]) =>
    path.join(repoRoot, relativePrefix),
  );

  const rows = [
    // Whole repo — the headline number, but NOT what the global gate compares
    // against.
    ['All files', summary.total],
    // What `coverageThreshold.global` actually measures: everything except the
    // directories that carry their own threshold.
    [
      '**Gated remainder** (`global`)',
      aggregate(
        summary,
        (file) => !criticalPrefixes.some((p) => file.startsWith(p)),
      ),
    ],
  ];

  for (const [label, relativePrefix] of CRITICAL_PATHS) {
    const absolutePrefix = path.join(repoRoot, relativePrefix);
    const group = aggregate(summary, (file) => file.startsWith(absolutePrefix));
    if (group) rows.push([`\`${label}\``, group]);
  }

  const lines = [
    '### Coverage',
    '',
    `| Scope | ${METRICS.map(capitalize).join(' | ')} |`,
    `|---|${METRICS.map(() => '---').join('|')}|`,
  ];

  for (const [label, data] of rows) {
    const cells = METRICS.map((metric) => format(data[metric]));
    lines.push(`| ${label} | ${cells.join(' | ')} |`);
  }

  lines.push(
    '',
    '> Jest subtracts every threshold group from the global pool, so the `global`',
    '> floor in `jest.config.js` is compared against **Gated remainder**, not',
    '> against All files.',
    '',
  );

  process.stdout.write(lines.join('\n'));
}

function aggregate(summary, includes) {
  const totals = Object.fromEntries(
    METRICS.map((metric) => [metric, { covered: 0, total: 0 }]),
  );
  let matched = 0;

  for (const [file, data] of Object.entries(summary)) {
    if (file === 'total') continue;
    if (!includes(file)) continue;

    matched += 1;
    for (const metric of METRICS) {
      totals[metric].covered += data[metric].covered;
      totals[metric].total += data[metric].total;
    }
  }

  if (matched === 0) return null;

  for (const metric of METRICS) {
    const { covered, total } = totals[metric];
    totals[metric].pct = total === 0 ? 100 : (100 * covered) / total;
  }

  return totals;
}

function format(metric) {
  if (!metric) return 'n/a';
  return `${metric.pct.toFixed(2)}% (${metric.covered}/${metric.total})`;
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

try {
  main();
} catch (error) {
  // Never fail the build over a reporting helper.
  process.stdout.write(
    `### Coverage\n\nFailed to render coverage summary: ${error.message}\n`,
  );
}
