/**
 * O ambiente do benchmark de escrita — **antes de qualquer import do app**.
 *
 * `ConfigModule` lê no import do decorador, então isto tem de ser o primeiro
 * import do script. Ver `test/support/enable-write-path.ts`, que documenta a
 * mesma armadilha.
 *
 * **Por que o teto de C10 sobe aqui, e não em `enable-write-path`.** Aquele
 * módulo é compartilhado com o E2E, e o E2E deve rodar com o teto real: ele
 * verifica comportamento, e o teto é parte do comportamento. Este script mede
 * **latência**, e o teto é um controle diferente — deixá-lo em 30 faria o
 * benchmark medir a recusa do limitador a partir da 31ª amostra, que é rápida e
 * não é o que §17.2 orça.
 *
 * O limitador tem teste próprio; nada aqui o dispensa.
 */
process.env.PLATFORM_ACTIONS_ENABLED = 'true';
process.env.PLATFORM_ACTIONS_DRY_RUN_ONLY = 'false';
process.env.PLATFORM_ACTIONS_ORG_RATE_LIMIT_PER_MINUTE = '100000';

export const BENCH_ENV_READY = true;
