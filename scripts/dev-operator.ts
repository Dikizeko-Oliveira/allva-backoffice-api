/**
 * Cria (ou promove) uma conta de **operador de plataforma** em desenvolvimento.
 *
 *   pnpm dev:operator
 *   pnpm dev:operator -- --email=alguem@allva.local --role=ALLVA_SUPPORT
 *
 * ## Por que existe
 *
 * Não há como conceder papel de plataforma por HTTP: é o B3 do mapa de
 * endpoints do backoffice (`PATCH /admin/accounts/:id/platform-role`), que
 * ainda não existe — hoje a única forma é `UPDATE` no banco. Sem uma conta
 * `ALLVA_OPERATOR`, nenhuma rota `/api/v1/admin/*` responde, e o painel
 * inteiro fica intestável localmente.
 *
 * O script não tenta ser o endpoint que falta. Ele é a versão local e
 * explícita do `UPDATE` que a pessoa faria à mão, com a mesma guarda de
 * ambiente do `dev-enterprise-org.ts` — conceder papel de plataforma é
 * escalada de privilégio em qualquer lugar que não seja a máquina de quem
 * desenvolve.
 *
 * `dev-token.ts` deliberadamente **não** faz isto, e a razão está escrita lá:
 * emitir token é conveniência, promover conta é outra coisa, e um comando que
 * fizesse as duas transformaria "quero testar uma rota" em "elevei um usuário
 * e esqueci". Aqui a promoção é o assunto do comando, não um efeito colateral.
 */
import 'dotenv/config';
import { randomUUID } from 'crypto';
import * as argon2 from 'argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, ACCOUNT_ROLE_TYPE } from '../generated/prisma/client';
import {
  PLATFORM_ROLES,
  isPlatformRole,
} from '../src/modules/accounts/domain/platform-rbac';

const DEFAULTS = {
  email: 'operador@allva.local',
  password: 'Operador@2026',
  name: 'Camila Operadora',
  role: 'ALLVA_ADMIN' as const,
};

function arg(flag: string): string | undefined {
  const match = process.argv.find((value) => value.startsWith(`--${flag}=`));
  return match?.slice(flag.length + 3);
}

/** A URL do banco é o fato que não mente sobre onde a escrita vai cair. */
function assertLocalDatabase(url: string | undefined): void {
  if (!url) throw new Error('DATABASE_URL ausente.');

  const host = new URL(url).hostname;

  if (
    !['localhost', '127.0.0.1', '::1', 'host.docker.internal'].includes(host)
  ) {
    throw new Error(
      `Recusado: DATABASE_URL aponta para "${host}", não para um banco local. ` +
        'Este script concede papel de plataforma e grava senha conhecida.',
    );
  }
}

async function main() {
  assertLocalDatabase(process.env.DATABASE_URL);

  const email = (arg('email') ?? DEFAULTS.email).trim().toLowerCase();
  const password = arg('password') ?? DEFAULTS.password;
  const name = arg('name') ?? DEFAULTS.name;
  const role = (arg('role') ?? DEFAULTS.role) as ACCOUNT_ROLE_TYPE;

  // A lista vem da matriz, e não de uma cópia aqui: um papel novo passa a
  // valer no script no mesmo commit em que ganha permissões.
  if (!isPlatformRole(role)) {
    throw new Error(
      `--role precisa ser um dos papéis de plataforma: ${PLATFORM_ROLES.join(', ')}.`,
    );
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    // Fora da transação: argon2 é lento de propósito.
    const passwordHash = await argon2.hash(password);
    const now = new Date();

    const account = await prisma.$transaction(async (tx) => {
      const saved = await tx.account.upsert({
        where: { email },
        // Promove a conta existente sem tocar em mais nada além da senha —
        // rodar de novo é trocar a senha, não recriar a pessoa.
        update: {
          role,
          passwordHash,
          emailVerified: true,
          emailVerifiedAt: now,
        },
        create: {
          id: randomUUID(),
          name,
          email,
          role,
          passwordHash,
          emailVerified: true,
          emailVerifiedAt: now,
        },
      });

      // A linha que todo cadastro cria (M-7). Um operador também recebe
      // e-mail com gate de preferência.
      await tx.preference.upsert({
        where: { accountId: saved.id },
        update: {},
        create: { id: randomUUID(), accountId: saved.id },
      });

      return saved;
    });

    console.log('');
    console.log('  Conta de operador pronta.');
    console.log('');
    console.log('  e-mail ', email);
    console.log('  senha  ', password);
    console.log('  papel  ', role);
    console.log('  id     ', account.id);
    console.log('');
    console.log('  Backoffice: http://localhost:3001');
    console.log('');
    console.log(
      '  Nota: o backoffice ainda resolve o operador por mock — `/auth/me`',
    );
    console.log('  não expõe `platformRole` (B0). Esta conta serve às rotas');
    console.log('  /api/v1/admin/* da API.');
    console.log('');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
