import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

export function connect(): PrismaService {
  return new PrismaService();
}

/** Esvazia as tabelas que a suíte usa. O banco é só da suíte. */
export async function truncate(
  prisma: PrismaService,
  tables: readonly string[],
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${tables.map((table) => `"${table}"`).join(', ')} CASCADE`,
  );
}
