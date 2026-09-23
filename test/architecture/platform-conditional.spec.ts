import { ESLint } from 'eslint';
import { parser } from 'typescript-eslint';
import {
  REPO_ROOT,
  SRC_ROOT,
  listTypeScriptFiles,
  toPosix,
} from './support/source-tree';

/* eslint-disable @typescript-eslint/no-require-imports -- `eslint-rules/` é CommonJS puro (o ESLint carrega o plugin em runtime) e o projeto não habilita allowJs, então `import` não tipa. */
const allva = require('../../eslint-rules/index.js') as ESLint.Plugin;

const RULE_ID = 'allva/no-platform-conditional';

/**
 * P6 — **multi-plataforma por contrato, não por condicional.**
 *
 * A regra vive em `eslint-rules/no-platform-conditional.js` e está ligada no
 * `eslint.config.mjs`, mas o passo de lint do CI ainda é `continue-on-error`
 * (dívida declarada no workflow). Rodá-la aqui, pela API do ESLint, põe P6 no
 * gate que **bloqueia** — `pnpm test` — sem esperar o lint virar obrigatório e
 * sem duplicar a lógica de detecção em duas implementações que divergiriam.
 *
 * A configuração é mínima de propósito: só o parser TypeScript e esta regra,
 * sem checagem de tipos. A regra é sintática, e um `projectService` aqui
 * levaria o teste de segundos a minutos.
 *
 * A lista de arquivos é montada aqui, e não pelo glob do ESLint, porque o glob
 * dele usa `import()` dinâmico — que o Jest em CommonJS não consegue executar.
 */
function createLinter(): ESLint {
  return new ESLint({
    cwd: REPO_ROOT,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.ts'],
        languageOptions: { parser },
        plugins: { allva },
        rules: { 'allva/no-platform-conditional': 'error' },
      },
    ],
  });
}

describe('P6 — condicional por plataforma', () => {
  jest.setTimeout(120_000);

  it('não existe fora de infrastructure/providers', async () => {
    const linter = createLinter();
    const files = listTypeScriptFiles(SRC_ROOT)
      .map(toPosix)
      .filter(
        (path) =>
          !path.includes('/infrastructure/providers/') &&
          !path.endsWith('.spec.ts'),
      );

    expect(files.length).toBeGreaterThan(100);

    const results = await linter.lintFiles(files);
    // Filtrar por `ruleId` é obrigatório: a config mínima não conhece as regras
    // citadas nos `eslint-disable` do repositório, e o ESLint reporta cada uma
    // dessas diretivas como erro próprio. Sem o filtro, o teste acusaria P6 em
    // arquivos que nem falam de plataforma.
    const offenders = results.flatMap((result) =>
      result.messages
        .filter((message) => message.ruleId === RULE_ID)
        .map(
          (message) =>
            `${result.filePath.replace(`${REPO_ROOT}/`, '')}:${message.line}`,
        ),
    );

    expect(offenders).toEqual([]);
  });

  it('a regra realmente pega as três formas de perguntar', async () => {
    const linter = createLinter();

    const violations = `
      declare const platform: string;
      declare const ad: { platform: string };
      export function a() { return platform === 'META' ? 1 : 2; }
      export function b() { return ad.platform !== 'GOOGLE'; }
      export function c() { switch (ad.platform) { case 'TIKTOK': return 1; default: return 0; } }
      export function d() { return ['META', 'GOOGLE'].includes(platform); }
    `;

    const [result] = await linter.lintText(violations, {
      filePath: 'src/modules/fake/violations.ts',
    });

    // Uma verificação que não falha quando deveria é pior que nenhuma: passa a
    // atestar conformidade que ninguém mediu.
    expect(result.messages.filter((m) => m.ruleId === RULE_ID)).toHaveLength(4);

    const allowed = `
      declare const platform: 'META' | 'GOOGLE' | 'TIKTOK';
      const PROFILES = { META: 1, GOOGLE: 2, TIKTOK: 3 };
      export function ok() { return PROFILES[platform]; }
    `;

    const [clean] = await linter.lintText(allowed, {
      filePath: 'src/modules/fake/allowed.ts',
    });

    // Indexar uma tabela declarativa é a forma **correta** de tratar a
    // diferença: exaustiva por construção, sem `else` para esquecer.
    expect(clean.messages.filter((m) => m.ruleId === RULE_ID)).toEqual([]);
  });
});
