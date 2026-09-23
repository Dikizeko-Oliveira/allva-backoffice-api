/**
 * Testes unitários co-localizados (`src/**\/*.spec.ts`) e os gates de
 * arquitetura (`test/architecture/`), que precisam enxergar o repositório
 * inteiro e por isso não moram em `src/`.
 *
 * A suíte roda **sem infraestrutura**: nenhum spec abre conexão com o banco
 * nem chama o `allva-api`.
 */
/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  roots: ['<rootDir>', '<rootDir>/../test'],
  testRegex: '.*\\.spec\\.ts$',
  setupFiles: ['<rootDir>/../test/support/test-env.ts'],
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    '^src/(.*)$': '<rootDir>/$1',
    // O cliente Prisma gerado vive fora de `src/`, e `rootDir` é `src/`.
    '^generated/(.*)$': '<rootDir>/../generated/$1',
  },
  collectCoverageFrom: ['**/*.(t|j)s', '!**/*.module.ts', '!main.ts'],
  coverageDirectory: '../coverage',
  coverageReporters: ['text-summary', 'json-summary', 'lcov'],
  testEnvironment: 'node',
};
