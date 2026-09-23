const base = require('./jest.config');

/**
 * Os testes que exigem **infraestrutura de verdade** — Postgres e, no E2E,
 * o grafo inteiro do `AppModule`.
 *
 * ## Por que uma config separada, e não um filtro
 *
 * `jest.config.js` exclui `test/integration/` e `schema-gates-db` da suíte
 * principal, para que o job `verify` do CI rode sem containers. Um
 * `--testPathPattern` apontando para os mesmos arquivos **não os traz de volta**:
 * `testPathIgnorePatterns` vence o pattern, e o comando encontra zero testes e
 * sai com código 1. A primeira redação de `pnpm test:integration` fez exatamente
 * isso — e o modo de falha era enganoso, porque "nenhum teste encontrado" parece
 * ausência de teste, não config errada.
 *
 * ## O que muda em relação à base
 *
 * - **Sem `coverageThreshold`.** A catraca mede a suíte principal; aplicá-la a
 *   sete arquivos de integração reprovaria por um denominador que não é o dela.
 * - **`runInBand`.** As fixtures compartilham as mesmas tabelas: em paralelo, o
 *   cleanup de uma suíte apaga a fixture da outra, e a falha é intermitente.
 * - **`REQUIRE_DATABASE`** é setado pelo script: aqui, pular é o defeito.
 * - **`--experimental-vm-modules`**, também pelo script. `jose` é ESM-only e o
 *   provedor de JWT a carrega por import dinâmico; dentro da VM do Jest isso
 *   falha sem a flag. O efeito é traiçoeiro: o middleware de autenticação
 *   engole o erro, zera `req.user` e a aplicação responde `401` a um token
 *   perfeitamente válido — o que fez a primeira redação de
 *   `admin-routes-authorization` concluir que o operador não tinha acesso.
 */
module.exports = {
  ...base,
  testPathIgnorePatterns: ['/node_modules/'],
  testRegex: undefined,
  testMatch: [
    '<rootDir>/../test/integration/**/*.spec.ts',
    '<rootDir>/../test/architecture/schema-gates-db.spec.ts',
  ],
  coverageThreshold: undefined,
  collectCoverage: false,
};
