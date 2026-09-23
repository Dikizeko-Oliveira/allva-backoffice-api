/**
 * Defaults para as variáveis críticas de `env.ts`, só quando ausentes.
 *
 * A suíte roda sem infraestrutura — nenhum teste abre conexão nem chama o
 * `allva-api` —, mas `EnvModule` valida o ambiente ao montar o `AppModule`, e
 * sem estas duas o grafo nem compila. Valores descartáveis de propósito.
 */
process.env.DATABASE_URL ??=
  'postgresql://test:test@localhost:5433/allva_backoffice_test?schema=public';
process.env.ALLVA_API_URL ??= 'http://localhost:8080';
