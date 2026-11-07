import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { integrationDatabaseUrl } from './integration-database';

/** Aplica as migrações no banco da suíte antes de qualquer teste. */
export default function globalSetup(): void {
  const url = integrationDatabaseUrl();

  execFileSync('pnpm', ['prisma', 'migrate', 'deploy'], {
    cwd: resolve(__dirname, '../../..'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });
}
