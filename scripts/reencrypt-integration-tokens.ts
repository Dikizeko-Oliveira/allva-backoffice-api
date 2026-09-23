/* eslint-disable no-console */
/**
 * Re-encrypt legacy integration tokens.
 *
 * Usage:
 *   pnpm run integrations:reencrypt-tokens -- --dry-run
 *   pnpm run integrations:reencrypt-tokens
 *
 * Safety:
 *   - Idempotent — tokens already starting with `v1:` are skipped.
 *   - Never logs token values; only counts and ids.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { createCipheriv, randomBytes, scryptSync } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const VERSION_PREFIX = 'v1:';
const SCRYPT_SALT = 'allva-integration-token-cipher';

function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `${VERSION_PREFIX}${iv.toString('base64')}:${authTag.toString(
    'base64',
  )}:${encrypted.toString('base64')}`;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const secret = process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) {
    console.error(
      'INTEGRATION_TOKEN_ENCRYPTION_KEY missing or too short (need >=32 chars)',
    );
    process.exit(1);
  }
  const key = scryptSync(secret, SCRYPT_SALT, KEY_LENGTH);

  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost')
      ? undefined
      : { rejectUnauthorized: false },
  });
  const prisma = new PrismaClient({ adapter });
  try {
    const rows = (await prisma.integration.findMany({
      select: {
        id: true,
        accessToken: true,
        refreshToken: true,
      },
    })) as Array<{
      id: string;
      accessToken: string;
      refreshToken: string | null;
    }>;

    let alreadyEncrypted = 0;
    let toMigrate = 0;
    let migrated = 0;
    let errors = 0;

    for (const row of rows) {
      const accessNeeds = !row.accessToken.startsWith(VERSION_PREFIX);
      const refreshNeeds =
        row.refreshToken && !row.refreshToken.startsWith(VERSION_PREFIX);

      if (!accessNeeds && !refreshNeeds) {
        alreadyEncrypted += 1;
        continue;
      }
      toMigrate += 1;

      const data: Record<string, string> = {};
      try {
        if (accessNeeds) data.accessToken = encrypt(row.accessToken, key);
        if (refreshNeeds && row.refreshToken)
          data.refreshToken = encrypt(row.refreshToken, key);

        if (!dryRun) {
          await prisma.integration.update({
            where: { id: row.id },
            data: data as never,
          });
        }
        migrated += 1;
      } catch (err) {
        errors += 1;
        console.error(
          `Failed to re-encrypt integration ${row.id}: ${(err as Error).message}`,
        );
      }
    }

    console.log(
      JSON.stringify(
        {
          total: rows.length,
          alreadyEncrypted,
          toMigrate,
          migrated,
          errors,
          dryRun,
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
