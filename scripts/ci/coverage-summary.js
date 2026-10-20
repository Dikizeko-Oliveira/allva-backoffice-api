#!/usr/bin/env node
/**
 * Imprime o resumo de cobertura em Markdown, para o `$GITHUB_STEP_SUMMARY`.
 *
 * Lê `coverage/coverage-summary.json` (reporter `json-summary` do Jest). Sem o
 * arquivo — testes que nem chegaram a rodar — não imprime nada e sai com 0: o
 * passo existe para mostrar o número, não para ser mais um motivo de falha.
 */
const fs = require('fs');
const path = require('path');

const file = path.join(process.cwd(), 'coverage', 'coverage-summary.json');

if (!fs.existsSync(file)) process.exit(0);

const { total } = JSON.parse(fs.readFileSync(file, 'utf8'));

const rows = ['lines', 'statements', 'functions', 'branches'].map(
  (metric) =>
    `| ${metric} | ${total[metric].pct}% | ${total[metric].covered}/${total[metric].total} |`,
);

console.log(
  ['### Cobertura', '', '| Métrica | % | Cobertas |', '|---|---|---|', ...rows].join(
    '\n',
  ),
);
