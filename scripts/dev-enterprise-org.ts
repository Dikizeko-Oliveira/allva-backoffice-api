/**
 * Cria (ou recria) uma organização **Enterprise** de desenvolvimento, com uma
 * conta que faz login de verdade.
 *
 *   pnpm dev:enterprise
 *   pnpm dev:enterprise -- --email=alguem@allva.local --password=OutraSenha1
 *   pnpm dev:enterprise -- --no-tickets
 *
 * ## Por que ele existe
 *
 * `bootstrap-dev.ts` semeia uma organização no plano FREE e uma conta com
 * hash inválido de propósito — ela ancora FKs, não faz login. Isso basta para
 * o seed de anúncios e para os testes de integração, e não basta para abrir o
 * navegador: a Central de suporte (`/account/support/*`) é exclusiva do
 * Enterprise, e não havia como chegar nela em desenvolvimento sem editar o
 * banco na mão.
 *
 * ## O contrato fica de fora, de propósito
 *
 * Em produção quem provisiona Enterprise é `EnterpriseProvisioningService`,
 * disparado pela ativação de um `EnterpriseContract` — e é o contrato que diz
 * até quando o acesso vale. Aqui não há contrato, e `resolveOrganizationAccess`
 * documenta exatamente o que isso significa: sem contrato, o `ACTIVE` da
 * assinatura concede acesso **para sempre**. É a propriedade que se quer numa
 * fixture de desenvolvimento, e é a razão de não copiar a vigência para cá:
 * uma fixture que expira é uma fixture que quebra sozinha no meio de um teste.
 *
 * A consequência a conhecer: `managedByContract` sai `false`, então a tela de
 * cobrança mostra os controles de autoatendimento. Para testar a tela de
 * cobrança de um Enterprise real, ative um contrato pelo fluxo de operador.
 *
 * ## Nunca fora de desenvolvimento
 *
 * Grava senha conhecida e marca e-mail como verificado. As duas coisas são
 * convenientes numa máquina local e são escalada de privilégio em qualquer
 * outro lugar — por isso a guarda de ambiente abaixo aborta antes de tocar no
 * banco, em vez de confiar em quem digita o comando.
 */
import 'dotenv/config';
import { randomUUID, randomInt } from 'crypto';
import * as argon2 from 'argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

const DEFAULTS = {
  email: 'enterprise@allva.local',
  password: 'Enterprise@2026',
  name: 'Ana Enterprise',
  org: 'Allva Enterprise (dev)',
};

function arg(flag: string): string | undefined {
  const match = process.argv.find((value) => value.startsWith(`--${flag}=`));
  return match?.slice(flag.length + 3);
}

/**
 * Localhost, e não `NODE_ENV`.
 *
 * `NODE_ENV` é o que mais fácil se esquece de setar — e o esquecimento erra
 * para o lado de rodar isto contra staging. A URL do banco é o fato que não
 * mente sobre onde a escrita vai cair.
 */
function assertLocalDatabase(url: string | undefined): void {
  if (!url) throw new Error('DATABASE_URL ausente.');

  const host = new URL(url).hostname;

  if (
    !['localhost', '127.0.0.1', '::1', 'host.docker.internal'].includes(host)
  ) {
    throw new Error(
      `Recusado: DATABASE_URL aponta para "${host}", não para um banco local. ` +
        'Este script grava senha conhecida e e-mail já verificado.',
    );
  }
}

/** `SUP-20260828-7K4N` — mesmo formato de `SupportTicket.create`. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function ticketCode(createdAt: Date): string {
  const datePart = createdAt.toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = Array.from({ length: 4 }, () =>
    CODE_ALPHABET.charAt(randomInt(0, CODE_ALPHABET.length)),
  ).join('');

  return `SUP-${datePart}-${suffix}`;
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

async function main() {
  assertLocalDatabase(process.env.DATABASE_URL);

  const email = (arg('email') ?? DEFAULTS.email).trim().toLowerCase();
  const password = arg('password') ?? DEFAULTS.password;
  const name = arg('name') ?? DEFAULTS.name;
  const orgName = arg('org') ?? DEFAULTS.org;
  const withTickets = !process.argv.includes('--no-tickets');

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    const plan = await prisma.plan.findUnique({
      where: { type: 'ENTERPRISE' },
    });

    if (!plan) {
      throw new Error(
        'Tabela `plans` sem o ENTERPRISE. Rode `pnpm run seed:plans` antes.',
      );
    }

    // Fora da transação: argon2 é deliberadamente lento (é o ponto dele), e
    // segurar uma transação aberta durante o hash não tem por quê.
    const passwordHash = await argon2.hash(password);
    const now = new Date();

    const result = await prisma.$transaction(async (tx) => {
      // Idempotente: rodar de novo troca a senha e reafirma o plano, em vez de
      // estourar no índice único de `accounts.email`.
      const account = await tx.account.upsert({
        where: { email },
        update: { passwordHash, emailVerified: true, emailVerifiedAt: now },
        create: {
          id: randomUUID(),
          name,
          email,
          passwordHash,
          // O fluxo self-serve exigiria confirmar o e-mail, e não há caixa de
          // entrada em `@allva.local` — sem isto o login responde
          // `EMAIL_NOT_VERIFIED` e a fixture nasce inutilizável.
          emailVerified: true,
          emailVerifiedAt: now,
        },
      });

      /**
       * A linha de preferências que todo cadastro cria — reproduzida aqui
       * porque este script curto-circuita `AccountOnboardingService`, e sem
       * ela o e-mail com gate de preferência não alcança a conta (M-7).
       *
       * `reviewedAt` fica nulo: ninguém abriu a tela de notificações. É o que
       * mantém o passo correspondente do checklist de primeiros passos
       * **pendente**, que é o estado honesto de uma conta recém-criada.
       */
      await tx.preference.upsert({
        where: { accountId: account.id },
        update: {},
        create: { id: randomUUID(), accountId: account.id },
      });

      const existing = await tx.organization.findFirst({
        where: { ownerId: account.id, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      });

      const organization =
        existing ??
        (await tx.organization.create({
          data: {
            id: randomUUID(),
            ownerId: account.id,
            name: orgName,
            // Razão social declarada, como no provisionamento Enterprise real.
            // Só o cadastro self-serve nasce com nome derivado e por confirmar.
            nameConfirmedAt: now,
          },
        }));

      // `owner_id` nomeia o criador; quem o RBAC lê é a participação.
      await tx.organizationUser.upsert({
        where: {
          organizationId_accountId: {
            organizationId: organization.id,
            accountId: account.id,
          },
        },
        update: { role: 'OWNER', status: 'ACTIVE', deletedAt: null },
        create: {
          id: randomUUID(),
          organizationId: organization.id,
          accountId: account.id,
          role: 'OWNER',
          status: 'ACTIVE',
        },
      });

      await tx.organizationAdsSettings.upsert({
        where: { organizationId: organization.id },
        update: {},
        create: { organizationId: organization.id },
      });

      /**
       * `ACTIVE` sem `trialEndsAt` — o mesmo `onPlan()` que a ativação de
       * contrato grava. `TRIALING` faria `ExpireOrganizationTrialsUseCase`
       * fechar o acesso da fixture depois de quatorze dias.
       */
      const subscription = await tx.organizationSubscription.upsert({
        where: { organizationId: organization.id },
        update: { planId: plan.id, status: 'ACTIVE', trialEndsAt: null },
        create: {
          id: randomUUID(),
          organizationId: organization.id,
          planId: plan.id,
          status: 'ACTIVE',
          trialStartedAt: now,
          trialEndsAt: null,
        },
      });

      return { account, organization, subscription };
    });

    let ticketCount = 0;

    if (withTickets) {
      ticketCount = await seedTickets(
        prisma,
        result.account,
        result.organization.id,
      );
    }

    console.log('');
    console.log('  Organização Enterprise de desenvolvimento pronta.');
    console.log('');
    console.log('  e-mail      ', email);
    console.log('  senha       ', password);
    console.log(
      '  organização ',
      `${result.organization.name} (${result.organization.id})`,
    );
    console.log(
      '  plano       ',
      `${plan.name} / ${plan.type} — ACTIVE, sem prazo`,
    );
    if (withTickets) console.log('  chamados    ', `${ticketCount} semeados`);
    console.log('');
    console.log('  Central de suporte: /account/support');
    console.log('');
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Chamados de exemplo, gravados direto.
 *
 * **Não** via `POST /support/messages`: aquele caminho envia dois e-mails de
 * verdade por chamado (equipe e solicitante), e `EMAIL_PROVIDER` aponta para
 * um provedor real mesmo em desenvolvimento. Semear a tabela exercita as
 * telas sem mandar nada para ninguém.
 *
 * Os quatro status aparecem, e com idades diferentes, porque é o que faz as
 * abas, a contagem e o "tempo médio de resolução" mostrarem algo além de zero.
 */
async function seedTickets(
  prisma: PrismaClient,
  account: { id: string; name: string; email: string },
  organizationId: string,
): Promise<number> {
  const existing = await prisma.supportTicket.count({
    where: { organizationId },
  });

  if (existing > 0) {
    console.log(`  (${existing} chamado(s) já existiam — nada semeado)`);
    return existing;
  }

  const seeds = [
    {
      subject: 'Conta do Meta Ads parou de sincronizar',
      message:
        'A última ingestão trouxe dados até anteontem e desde então a conta 120... não atualiza.\n\nJá reconectei a credencial e o status continua CONNECTED.',
      category: 'TECHNICAL' as const,
      priority: 'HIGH' as const,
      status: 'OPEN' as const,
      createdAt: daysAgo(1),
      updatedAt: daysAgo(1),
    },
    {
      subject: 'Cobrança duplicada na fatura de setembro',
      message:
        'A fatura veio com dois lançamentos do mesmo valor no mesmo dia. Preciso do estorno de um deles para fechar o mês.',
      category: 'BILLING' as const,
      priority: 'CRITICAL' as const,
      status: 'IN_PROGRESS' as const,
      createdAt: daysAgo(4),
      updatedAt: daysAgo(1),
    },
    {
      subject: 'Como separar alertas críticos dos informativos?',
      message:
        'Queria receber só os alertas de desperdício por e-mail e deixar o resto no resumo diário. É possível hoje?',
      category: 'GENERAL' as const,
      priority: 'LOW' as const,
      status: 'RESOLVED' as const,
      createdAt: daysAgo(9),
      updatedAt: daysAgo(8),
    },
    {
      subject: 'Liberar perfil de administrador para o financeiro',
      message:
        'Precisamos promover a analista do financeiro para administrador.',
      category: 'ACCOUNT' as const,
      priority: 'MEDIUM' as const,
      status: 'CLOSED' as const,
      createdAt: daysAgo(20),
      updatedAt: daysAgo(18),
    },
  ];

  await prisma.supportTicket.createMany({
    data: seeds.map((seed) => ({
      id: randomUUID(),
      code: ticketCode(seed.createdAt),
      accountId: account.id,
      organizationId,
      authorName: account.name,
      authorEmail: account.email,
      subject: seed.subject,
      message: seed.message,
      category: seed.category,
      priority: seed.priority,
      status: seed.status,
      createdAt: seed.createdAt,
      updatedAt: seed.updatedAt,
    })),
  });

  return seeds.length;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
