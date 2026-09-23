/**
 * Checagem **somente leitura** da cobertura de câmbio e do orçamento
 * sincronizado — para rodar contra staging/produção antes de confiar no ritmo de
 * orçamento e em qualquer agregação em moeda-base.
 *
 * Três perguntas, nesta ordem:
 *   1. Toda moeda observada (de conta de anúncios ou moeda-base de organização)
 *      tem cotação `pivô → moeda` recente o bastante para o carry-forward de
 *      10 dias do conversor alcançar hoje?
 *   2. Por organização com conta em moeda diferente da base: a conversão de hoje
 *      resolve, e quantas linhas de série dos últimos 30 dias ficaram
 *      `normalization_pending` (fora de toda agregação, M1)?
 *   3. Por plataforma: quantas campanhas têm teto diário resolvível e quantos
 *      anúncios estão presos em `sync_quarantine` — anúncio sem campanha ou
 *      conjunto resolvido nunca chega à série, e o teto dele também não.
 *
 * Só executa SELECT. Uso:
 *   DATABASE_URL="postgresql://…?sslmode=no-verify" pnpm fx:check
 *   pnpm fx:check -- --pivot=USD
 *
 * Sai com código 1 quando alguma moeda necessária está sem cotação alcançável.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

/** O mesmo alcance do carry-forward em `CurrencyConverterService.ratesFor`. */
const CARRY_FORWARD_DAYS = 10;
const WINDOW_DAYS = 30;
/** `FX_BACKFILL_DAYS` padrão: abaixo disso, série antiga fica pendente. */
const BACKFILL_DAYS = 400;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

function pivotCurrency(): string {
  const flag = process.argv
    .slice(2)
    .find((arg) => arg.startsWith('--pivot='))
    ?.split('=')[1];
  return (flag ?? process.env.FX_PIVOT_CURRENCY ?? 'USD').toUpperCase();
}

function isoDay(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

type CoverageStatus = 'OK' | 'PIVÔ' | 'DEFASADA' | 'FALTANDO';

async function main() {
  const pivot = pivotCurrency();
  const today = new Date();
  const reachableSince = new Date(
    Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate() - CARRY_FORWARD_DAYS,
    ),
  );

  console.log(
    `🔎 pivô ${pivot} · carry-forward ${CARRY_FORWARD_DAYS}d · janela ${WINDOW_DAYS}d\n`,
  );

  // ── 1. cobertura por moeda ─────────────────────────────────────────────────
  const needed = await prisma.$queryRawUnsafe<Array<{ currency: string }>>(`
    SELECT DISTINCT upper(a.currency) AS currency
      FROM ad_accounts a
    UNION
    SELECT DISTINCT upper(o.base_currency)
      FROM organizations o
     WHERE o.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM ad_accounts a WHERE a.organization_id = o.id)
  `);

  const coverage = await prisma.$queryRawUnsafe<
    Array<{
      currency: string;
      latest: Date | null;
      days_window: number;
      days_backfill: number;
      sources: string | null;
    }>
  >(
    `
    SELECT upper(to_currency) AS currency,
           max(date) AS latest,
           count(DISTINCT date) FILTER (WHERE date >= current_date - ${WINDOW_DAYS})::int AS days_window,
           count(DISTINCT date) FILTER (WHERE date >= current_date - ${BACKFILL_DAYS})::int AS days_backfill,
           string_agg(DISTINCT source, ',') AS sources
      FROM fx_rates
     WHERE upper(from_currency) = $1
     GROUP BY 1
  `,
    pivot,
  );
  const coverageByCurrency = new Map(
    coverage.map((row) => [row.currency, row]),
  );

  const statusByCurrency = new Map<string, CoverageStatus>();
  const currencyTable = needed
    .map(({ currency }) => {
      const row = coverageByCurrency.get(currency);
      const status: CoverageStatus =
        currency === pivot
          ? 'PIVÔ'
          : !row?.latest
            ? 'FALTANDO'
            : row.latest < reachableSince
              ? 'DEFASADA'
              : 'OK';
      statusByCurrency.set(currency, status);

      return {
        moeda: currency,
        status,
        ultimaCotacao: isoDay(row?.latest ?? null),
        [`dias_${WINDOW_DAYS}d`]: row?.days_window ?? 0,
        [`dias_${BACKFILL_DAYS}d`]: row?.days_backfill ?? 0,
        fontes: row?.sources ?? null,
      };
    })
    .sort((a, b) => a.moeda.localeCompare(b.moeda));

  console.log('1. Cobertura de câmbio por moeda observada');
  console.table(currencyTable);

  const seedSources = coverage.filter((row) =>
    (row.sources ?? '').split(',').includes('seed'),
  );
  if (seedSources.length > 0) {
    console.warn(
      `⚠️  cotação com fonte "seed" em ${seedSources.map((row) => row.currency).join(', ')} — ` +
        'esperado só em banco local; em staging/produção é dado inventado.',
    );
  }

  // ── 2. organizações com conta em moeda diferente da base ───────────────────
  const pairs = await prisma.$queryRawUnsafe<
    Array<{
      organization_id: string;
      organization: string;
      base: string;
      currency_state: string;
      platform: string;
      account_currency: string;
      accounts: number;
    }>
  >(`
    SELECT o.id AS organization_id, o.name AS organization,
           upper(o.base_currency) AS base, o.currency_state::text AS currency_state,
           a.platform::text AS platform, upper(a.currency) AS account_currency,
           count(DISTINCT a.id)::int AS accounts
      FROM ad_accounts a
      JOIN organizations o ON o.id = a.organization_id
     WHERE o.deleted_at IS NULL
       AND upper(a.currency) <> upper(o.base_currency)
     GROUP BY 1, 2, 3, 4, 5, 6
     ORDER BY 2, 5
  `);

  const pending = await prisma.$queryRawUnsafe<
    Array<{ organization_id: string; pending: number; total: number }>
  >(`
    SELECT organization_id,
           count(*) FILTER (WHERE normalization_pending)::int AS pending,
           count(*)::int AS total
      FROM ad_metric_snapshots
     WHERE date >= current_date - ${WINDOW_DAYS}
     GROUP BY 1
  `);
  const pendingByOrganization = new Map(
    pending.map((row) => [row.organization_id, row]),
  );

  const reachable = (currency: string) =>
    ['OK', 'PIVÔ'].includes(statusByCurrency.get(currency) ?? '');

  console.log(
    '\n2. Organizações com conta em moeda diferente da base (o caso que exige câmbio)',
  );
  if (pairs.length === 0) {
    console.log(
      '   nenhuma — toda conta está na moeda-base da organização; o ritmo não depende de câmbio.',
    );
  } else {
    console.table(
      pairs.map((row) => {
        const series = pendingByOrganization.get(row.organization_id);
        return {
          organizacao: row.organization,
          id: row.organization_id,
          plataforma: row.platform,
          par: `${row.account_currency}→${row.base}`,
          contas: row.accounts,
          estadoMoeda: row.currency_state,
          converteHoje:
            reachable(row.account_currency) && reachable(row.base)
              ? 'sim'
              : 'NÃO',
          [`pendentes_${WINDOW_DAYS}d`]: series
            ? `${series.pending}/${series.total}`
            : 'sem série',
        };
      }),
    );
  }

  // ── 3. orçamento e quarentena por plataforma ───────────────────────────────
  const budgets = await prisma.$queryRawUnsafe<
    Array<{
      platform: string;
      campaigns: number;
      campaign_daily: number;
      campaign_lifetime: number;
      resolvable_daily: number;
    }>
  >(`
    SELECT c.platform::text AS platform,
           count(*)::int AS campaigns,
           count(*) FILTER (WHERE c.daily_budget > 0)::int AS campaign_daily,
           count(*) FILTER (WHERE c.lifetime_budget > 0)::int AS campaign_lifetime,
           count(*) FILTER (
             WHERE c.daily_budget > 0
                OR EXISTS (
                  SELECT 1 FROM ad_sets s
                   WHERE s.campaign_id = c.id
                     AND s.archived_at IS NULL
                     AND s.daily_budget > 0
                )
           )::int AS resolvable_daily
      FROM campaigns c
     WHERE c.archived_at IS NULL
     GROUP BY 1
     ORDER BY 1
  `);

  const adSets = await prisma.$queryRawUnsafe<
    Array<{ platform: string; ad_sets: number }>
  >(`
    SELECT platform::text AS platform, count(*)::int AS ad_sets
      FROM ad_sets
     WHERE archived_at IS NULL
     GROUP BY 1
  `);
  const adSetsByPlatform = new Map(adSets.map((row) => [row.platform, row]));

  const quarantine = await prisma.$queryRawUnsafe<
    Array<{ platform: string; reason: string; open: number }>
  >(`
    SELECT a.platform::text AS platform, q.reason, count(*)::int AS open
      FROM sync_quarantine q
      JOIN ad_accounts a ON a.id = q.ad_account_id
     WHERE q.resolved_at IS NULL
     GROUP BY 1, 2
     ORDER BY 1, 2
  `);

  console.log('\n3a. Campanhas não arquivadas e teto diário, por plataforma');
  console.table(
    budgets.map((row) => ({
      plataforma: row.platform,
      campanhas: row.campaigns,
      conjuntos: adSetsByPlatform.get(row.platform)?.ad_sets ?? 0,
      tetoNaCampanha: row.campaign_daily,
      voo: row.campaign_lifetime,
      tetoResolvivel: row.resolvable_daily,
    })),
  );

  console.log('\n3b. Quarentena aberta (anúncio sem pai resolvido)');
  if (quarantine.length === 0) console.log('   vazia');
  else console.table(quarantine);

  const failing = [...statusByCurrency.entries()].filter(
    ([, status]) => status === 'FALTANDO' || status === 'DEFASADA',
  );
  if (failing.length > 0) {
    console.error(
      `\n❌ sem cotação alcançável hoje: ${failing.map(([currency, status]) => `${currency} (${status})`).join(', ')}`,
    );
    process.exitCode = 1;
    return;
  }

  console.log('\n✅ toda moeda observada tem cotação alcançável hoje');
}

main()
  .catch((error) => {
    console.error('❌ checagem falhou:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
