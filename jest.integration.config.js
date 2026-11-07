const base = require('./jest.config');

/**
 * A suíte que roda contra um **Postgres de verdade** (GAP-048).
 *
 * - **Banco dedicado.** Lê `INTEGRATION_DATABASE_URL`, nunca o `DATABASE_URL`
 *   do `.env`: os testes truncam as tabelas que usam, e o banco de
 *   desenvolvimento tem dado que alguém quer manter. O setup recusa um banco
 *   cujo nome não diga `test`, `integration` ou `ci`.
 * - **`migrate deploy` primeiro**, no `globalSetup`: é o mesmo caminho da
 *   produção, e um banco vazio que não migra é o primeiro defeito a pegar.
 * - **`runInBand`**, pelo script: as suítes compartilham as tabelas.
 */
/** @type {import('jest').Config} */
module.exports = {
  ...base,
  roots: ['<rootDir>/../test/integration'],
  testPathIgnorePatterns: ['/node_modules/'],
  setupFiles: ['<rootDir>/../test/integration/support/integration-env.ts'],
  globalSetup: '<rootDir>/../test/integration/support/global-setup.ts',
  collectCoverageFrom: undefined,
};
