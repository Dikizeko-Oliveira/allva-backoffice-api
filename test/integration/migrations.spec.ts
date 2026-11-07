import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { connect } from './support/prisma';

/**
 * O `globalSetup` rodou `prisma migrate deploy` no banco da suíte. Este teste
 * confere que todas as migrações do repositório foram aplicadas — um banco que
 * não migra do zero é o primeiro defeito a pegar (GAP-048).
 */
describe('migrações', () => {
  let prisma: PrismaService;

  beforeAll(() => {
    prisma = connect();
  });
  afterAll(() => prisma.$disconnect());

  it('todas as migrações do repositório estão aplicadas', async () => {
    const expected = readdirSync(
      resolve(__dirname, '../../prisma/migrations'),
      {
        withFileTypes: true,
      },
    )
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    const applied = await prisma.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM _prisma_migrations
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
      ORDER BY migration_name`;

    expect(applied.map((row) => row.migration_name)).toEqual(expected);
  });
});
