/**
 * Emite um access token de desenvolvimento para bater nas rotas autenticadas.
 *
 *   pnpm dev:token                      # primeira conta do banco
 *   pnpm dev:token owner@empresa.com    # uma conta específica
 *
 * Existe porque testar uma rota protegida à mão exigia percorrer o fluxo de
 * login inteiro — e a alternativa que eu vinha usando era um arquivo solto na
 * raiz do repositório, que é pior de todas as formas.
 *
 * ## O que ele deliberadamente NÃO faz
 *
 * **Não muda o papel de ninguém.** Emitir token é conveniência; promover uma
 * conta a `ALLVA_OPERATOR` é escalar privilégio, e um script que faz as duas
 * coisas de uma vez transforma "quero testar uma rota" em "elevei um usuário e
 * esqueci". Ele imprime o papel atual e para por aí: quem precisa de operador
 * muda o papel de propósito, num comando separado.
 */
import 'dotenv/config';
import { randomUUID, createHash } from 'crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

/**
 * `jose` v6 é ESM-only, e estes scripts rodam sob `ts-node` em CommonJS: um
 * `import` estático seria rebaixado para `require()` e estouraria
 * `ERR_REQUIRE_ESM` em tempo de execução. É o mesmo motivo, e a mesma solução,
 * de `JwtJoseProvider` — o argumento é constante, então isto é interoperação de
 * módulo, não `eval`.
 */
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const importJose = new Function('return import("jose")') as () => Promise<
  typeof import('jose')
>;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

/**
 * Um token vale para quem o tiver. Contra um banco remoto, este script deixa de
 * ser ferramenta de desenvolvimento e vira uma chave da conta de alguém.
 */
function assertLocalDatabase(): void {
  const url = process.env.DATABASE_URL ?? '';
  const isLocal = /@(localhost|127\.0\.0\.1|host\.docker\.internal)[:/]/.test(
    url,
  );

  if (!isLocal) {
    throw new Error(
      'DATABASE_URL não aponta para um banco local. Este script emite ' +
        'credenciais e só roda contra localhost.',
    );
  }
}

async function main() {
  assertLocalDatabase();

  const secret = process.env.JWT_SECRET_KEY;
  if (!secret) throw new Error('JWT_SECRET_KEY não está definida.');

  const email = process.argv[2];

  const account = email
    ? await prisma.account.findUnique({ where: { email } })
    : await prisma.account.findFirst({ orderBy: { createdAt: 'asc' } });

  if (!account) {
    throw new Error(
      email ? `Conta não encontrada: ${email}` : 'Nenhuma conta no banco.',
    );
  }

  /**
   * Sessão real, e não só um JWT assinado.
   *
   * O token carrega `sid`, e o fluxo de refresh e a detecção de reuso do Sprint
   * 6 partem de uma linha em `sessions`. Um `sid` inventado renderia um token
   * que autentica mas quebra no primeiro refresh — o tipo de fixture que engana
   * o teste.
   */
  const session = await prisma.session.create({
    data: {
      id: randomUUID(),
      accountId: account.id,
      // A sessão é só âncora do `sid`: o refresh token de verdade nunca é
      // emitido aqui, então o hash é de um valor descartado.
      refreshTokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      userAgent: 'scripts/dev-token.ts',
    },
  });

  const { SignJWT } = await importJose();

  const token = await new SignJWT({
    sub: account.id,
    sid: session.id,
    email: account.email,
    name: account.name,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret));

  const organization = await prisma.organization.findFirst({
    where: { ownerId: account.id, deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });

  console.log(`conta         ${account.email}`);
  console.log(`papel         ${account.role}`);
  console.log(`organização   ${organization?.id ?? '(nenhuma)'}`);
  console.log(`expira em     1h\n`);
  console.log(`export TOKEN='${token}'\n`);
  console.log(
    'curl -H "Authorization: Bearer $TOKEN" ' +
      'http://localhost:3333/api/v1/billing/subscription',
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
