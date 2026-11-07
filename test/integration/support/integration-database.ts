/**
 * O banco da suíte de integração. Separado do de desenvolvimento por
 * construção: sem `INTEGRATION_DATABASE_URL`, não há suíte.
 */
const SAFE_DATABASE_NAME = /(test|integration|ci)/i;

export function integrationDatabaseUrl(): string {
  const url = process.env.INTEGRATION_DATABASE_URL;

  if (!url) {
    throw new Error(
      'INTEGRATION_DATABASE_URL is required for pnpm test:integration ' +
        '(a dedicated database — never the development one)',
    );
  }

  const name = new URL(url).pathname.replace(/^\//, '');

  if (!SAFE_DATABASE_NAME.test(name)) {
    throw new Error(
      `Refusing to run integration tests against "${name}": the database ` +
        'name must contain test, integration or ci',
    );
  }

  return url;
}
