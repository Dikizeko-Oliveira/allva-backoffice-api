/**
 * **As campanhas Smart+ do TikTok entram na análise?** — verificação contra
 * conta real, somente leitura.
 *
 * O provider do TikTok lê `/campaign/get/`, `/adgroup/get/`, `/ad/get/` e o
 * relatório `AUCTION_AD`. As campanhas Smart+ ("Upgraded Smart+") têm rotas
 * próprias (`/smart_plus/campaign/get/`, `/smart_plus/ad/get/`), e a
 * documentação não diz se as rotas padrão também as devolvem. Este script
 * responde isso numa conta de verdade:
 *
 *   1. lista as campanhas Smart+ pela rota própria;
 *   2. confere se as rotas padrão devolvem essas campanhas, seus grupos e seus
 *      anúncios;
 *   3. compara o gasto por anúncio (relatório padrão) com o gasto por campanha;
 *   4. confere o que o banco da Allva já tem delas, se a conta já sincronizou.
 *
 * O veredito diz se as rotas padrão cobrem o Smart+ ou se a leitura pelas
 * rotas próprias (D24, `TIKTOK_SMART_PLUS_ENABLED`) é necessária.
 *
 * Com `--compare`, roda também **o provider de verdade** duas vezes — com a
 * leitura Smart+ desligada e ligada — e compara o gasto que cada versão
 * entrega para as campanhas Smart+ com o gasto por campanha do relatório. É o
 * que decide se o interruptor pode ser ligado: gasto acima do da campanha é
 * contagem em dobro; leitura incompleta travaria o arquivamento da conta.
 *
 * Uso:
 *   pnpm verify:tiktok-smart-plus -- --ad-account=<id da conta na Allva>
 *   pnpm verify:tiktok-smart-plus -- --advertiser=<advertiser_id do TikTok>
 *   pnpm verify:tiktok-smart-plus -- --advertiser=<id> --days=30
 *   pnpm verify:tiktok-smart-plus -- --advertiser=<id> --compare
 *
 * Contra staging, o `DATABASE_URL` precisa de `?sslmode=no-verify` — passado
 * na linha de comando, nunca gravado no `.env` padrão.
 *
 * Segurança:
 *   - **somente leitura**: só `GET` na plataforma e só `SELECT` no banco;
 *   - o token é decifrado em memória e **nunca** impresso — nem em erro: a
 *     credencial vai no cabeçalho, e as mensagens da API não a repetem;
 *   - recusa integração do seed, que não é credencial de verdade.
 */
import 'dotenv/config';
import { createDecipheriv, scryptSync } from 'crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import type { AdAccount } from '../src/modules/integrations/domain/entities/ad-account.entity';
import type { Integration } from '../src/modules/integrations/domain/entities/integration.entity';
import type { ProviderSyncResult } from '../src/modules/integrations/domain/ports';
import { TikTokAdsProvider } from '../src/modules/integrations/infrastructure/providers/tiktok/tiktok-ads.provider';
import type { EnvService } from '../src/shared/infrastructure/config/env.service';

const TIKTOK_API = 'https://business-api.tiktok.com/open_api/v1.3';
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
/** O maior lote de ids que os filtros de listagem aceitam. */
const IDS_PER_FILTER = 100;
/** Diferença de gasto tolerada entre a soma por anúncio e a da campanha. */
const SPEND_TOLERANCE = 0.02;

// A mesma cifra de `TokenCipherService` — o script não sobe o Nest.
const VERSION_PREFIX = 'v1:';
const SCRYPT_SALT = 'allva-integration-token-cipher';
const SEED_MARKER = 'seed-';

type Args = {
  adAccount?: string;
  advertiser?: string;
  days: number;
  compare: boolean;
};

type TikTokEnvelope<T> = {
  code?: number;
  message?: string;
  data?: T;
};

type Page<T> = {
  list?: T[];
  page_info?: { total_page?: number };
};

type CampaignNode = {
  campaign_id?: string;
  campaign_name?: string;
  operation_status?: string;
  secondary_status?: string;
  [key: string]: unknown;
};

type AdNode = { ad_id?: string; campaign_id?: string };

type ReportRow = {
  dimensions?: Record<string, string>;
  metrics?: Record<string, string>;
};

type CallResult<T> =
  | { ok: true; items: T[] }
  | { ok: false; code: number | null; message: string };

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const value = (name: string) =>
    argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1];

  return {
    adAccount: value('ad-account'),
    advertiser: value('advertiser'),
    days: Number(value('days') ?? 14),
    compare: argv.includes('--compare'),
  };
}

function decrypt(payload: string, secret: string): string {
  // Token legado em texto puro: é assim que `TokenCipherService` o trata.
  if (!payload.startsWith(VERSION_PREFIX)) return payload;

  const [iv, tag, data] = payload.slice(VERSION_PREFIX.length).split(':');
  if (!iv || !tag || !data) throw new Error('Token cifrado malformado.');

  const key = scryptSync(secret, SCRYPT_SALT, 32);
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64'));

  return Buffer.concat([
    decipher.update(Buffer.from(data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function isoDay(offsetDays: number): string {
  const now = new Date();
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - offsetDays,
    ),
  )
    .toISOString()
    .slice(0, 10);
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

class TikTokReader {
  constructor(
    private readonly token: string,
    private readonly advertiserId: string,
  ) {}

  /** Todas as páginas de uma listagem. Recusa da API vira resultado, não exceção. */
  async list<T>(
    path: string,
    params: Record<string, string> = {},
  ): Promise<CallResult<T>> {
    const items: T[] = [];

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const url = new URL(`${TIKTOK_API}${path}`);
      url.searchParams.set('advertiser_id', this.advertiserId);
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
      url.searchParams.set('page', String(page));
      url.searchParams.set('page_size', String(PAGE_SIZE));

      let envelope: TikTokEnvelope<Page<T>>;
      try {
        const response = await fetch(url, {
          headers: { 'Access-Token': this.token },
        });
        envelope = (await response.json()) as TikTokEnvelope<Page<T>>;
        if (!response.ok && envelope.code === undefined) {
          return { ok: false, code: response.status, message: 'HTTP' };
        }
      } catch (error) {
        return { ok: false, code: null, message: (error as Error).message };
      }

      if (envelope.code !== 0) {
        return {
          ok: false,
          code: envelope.code ?? null,
          message: envelope.message ?? 'sem mensagem',
        };
      }

      const list = envelope.data?.list ?? [];
      items.push(...list);

      const totalPage = Number(envelope.data?.page_info?.total_page ?? 1);
      if (list.length === 0 || page >= totalPage) return { ok: true, items };
    }

    return { ok: true, items };
  }

  /** A mesma listagem, com o filtro de ids em lotes. */
  async listByIds<T>(
    path: string,
    filterKey: string,
    ids: string[],
  ): Promise<CallResult<T>> {
    const items: T[] = [];

    for (const batch of chunks(ids, IDS_PER_FILTER)) {
      const result = await this.list<T>(path, {
        filtering: JSON.stringify({ [filterKey]: batch }),
      });
      if (!result.ok) return result;
      items.push(...result.items);
    }

    return { ok: true, items };
  }

  /** Gasto agregado no período, por campanha ou por anúncio, das campanhas dadas. */
  async spend(
    dataLevel: 'AUCTION_CAMPAIGN' | 'AUCTION_AD',
    dimension: 'campaign_id' | 'ad_id',
    campaignIds: string[],
    window: { start: string; end: string },
  ): Promise<CallResult<ReportRow>> {
    const rows: ReportRow[] = [];

    for (const batch of chunks(campaignIds, IDS_PER_FILTER)) {
      const result = await this.list<ReportRow>('/report/integrated/get/', {
        report_type: 'BASIC',
        data_level: dataLevel,
        dimensions: JSON.stringify([dimension]),
        metrics: JSON.stringify(['spend', 'impressions']),
        start_date: window.start,
        end_date: window.end,
        filtering: JSON.stringify([
          {
            field_name: 'campaign_ids',
            filter_type: 'IN',
            filter_value: JSON.stringify(batch),
          },
        ]),
      });
      if (!result.ok) return result;
      rows.push(...result.items);
    }

    return { ok: true, items: rows };
  }
}

const sumSpend = (rows: ReportRow[]) =>
  rows.reduce((sum, row) => sum + Number(row.metrics?.spend ?? 0), 0);

const describeFailure = (result: { code: number | null; message: string }) =>
  `recusada (code ${result.code ?? '—'}: ${result.message})`;

async function resolveAccount(prisma: PrismaClient, args: Args) {
  if (Boolean(args.adAccount) === Boolean(args.advertiser)) {
    throw new Error(
      'Use `--ad-account=<id>` ou `--advertiser=<id>` (um dos dois).',
    );
  }

  const accounts = await prisma.adAccount.findMany({
    where: {
      platform: 'TIKTOK',
      ...(args.adAccount
        ? { id: args.adAccount }
        : { externalAccountId: args.advertiser }),
    },
    select: {
      id: true,
      name: true,
      externalAccountId: true,
      organizationId: true,
      currency: true,
      integration: {
        select: { id: true, name: true, status: true, accessToken: true },
      },
    },
  });

  if (accounts.length === 0) {
    throw new Error('Nenhuma conta TikTok com esse id na Allva.');
  }
  if (accounts.length > 1) {
    const list = accounts
      .map((a) => `  - ${a.id} (organização ${a.organizationId})`)
      .join('\n');
    throw new Error(
      `O advertiser está vinculado a ${accounts.length} contas. Escolha com --ad-account:\n${list}`,
    );
  }

  const [account] = accounts;
  if (!account.integration) {
    throw new Error('A conta está sem integração — reconecte o TikTok.');
  }
  if (
    account.externalAccountId.startsWith(SEED_MARKER) ||
    account.integration.name?.startsWith(SEED_MARKER)
  ) {
    throw new Error(
      'É a conta do seed: a integração é fake e não fala com o TikTok.',
    );
  }

  return account as typeof account & {
    integration: NonNullable<typeof account.integration>;
  };
}

/**
 * O provider com o interruptor na posição pedida. A configuração vem do `.env`
 * como na aplicação; só `TIKTOK_SMART_PLUS_ENABLED` é forçado.
 */
function providerWith(smartPlus: boolean): TikTokAdsProvider {
  const env = {
    get: (key: string) =>
      key === 'TIKTOK_SMART_PLUS_ENABLED' ? smartPlus : process.env[key],
  } as unknown as EnvService;

  return new TikTokAdsProvider(env, {
    sign: () => Promise.reject(new Error('não usado')),
    verify: () => Promise.reject(new Error('não usado')),
  } as never);
}

function summarize(result: ProviderSyncResult, smartIds: Set<string>) {
  const smartSpend = result.metrics
    .filter(
      (row) =>
        row.level === 'AD' &&
        row.campaignExternalId !== null &&
        row.campaignExternalId !== undefined &&
        smartIds.has(row.campaignExternalId),
    )
    .reduce((sum, row) => sum + row.spend, 0);

  return {
    ads: result.ads?.length ?? 0,
    smartUnits: (result.ads ?? []).filter((ad) => ad.unitKind === 'ASSET_GROUP')
      .length,
    smartSpend,
    failedSteps: (result.stepFailures ?? []).map((failure) => failure.step),
    complete: result.wasComplete,
  };
}

async function compareProvider(input: {
  token: string;
  advertiserId: string;
  currency: string;
  days: number;
  smartIds: string[];
  campaignSpend: number | null;
}) {
  const adAccount = {
    externalAccountId: input.advertiserId,
    currency: input.currency,
  } as unknown as AdAccount;
  const integration = { accessToken: input.token } as unknown as Integration;
  const range = {
    since: new Date(`${isoDay(input.days)}T00:00:00.000Z`),
    until: new Date(`${isoDay(1)}T00:00:00.000Z`),
  };
  const run = (smartPlus: boolean) =>
    providerWith(smartPlus).syncAdAccountMetrics(
      adAccount,
      integration,
      range,
      { levels: ['AD', 'CREATIVE'] },
    );

  const smartIds = new Set(input.smartIds);
  const off = summarize(await run(false), smartIds);
  const on = summarize(await run(true), smartIds);

  const line = (label: string, s: ReturnType<typeof summarize>) =>
    `   - ${label}: ${s.ads} unidades (${s.smartUnits} Smart+), gasto nas campanhas Smart+ ${s.smartSpend.toFixed(2)}, ` +
    (s.complete
      ? 'leitura completa'
      : `leitura INCOMPLETA (${s.failedSteps.join(', ')})`);

  console.log('5. O provider da Allva, com a leitura Smart+ (D24):');
  console.log(line('desligada', off));
  console.log(line('ligada', on));

  const expected = input.campaignSpend;
  let verdict: string;

  if (!on.complete) {
    verdict =
      'NÃO LIGAR — ligada, a leitura fica incompleta. A conta deixaria de ' +
      'arquivar o que some; o ajuste está nas etapas acima.';
  } else if (expected === null || expected === 0) {
    verdict =
      'INCONCLUSIVO — sem gasto por campanha no período para comparar. Rode ' +
      'com uma janela maior (--days) numa conta com entrega.';
  } else if (on.smartSpend > expected * (1 + SPEND_TOLERANCE)) {
    verdict =
      `NÃO LIGAR — ligada, o gasto do Smart+ (${on.smartSpend.toFixed(2)}) passa ` +
      `o da campanha (${expected.toFixed(2)}): há contagem em dobro.`;
  } else if (on.smartSpend < expected * (1 - SPEND_TOLERANCE)) {
    verdict =
      `LIGAR COM RESSALVA — ligada, cobre ${((on.smartSpend / expected) * 100).toFixed(0)}% ` +
      'do gasto das campanhas Smart+ (desligada, ' +
      `${((off.smartSpend / expected) * 100).toFixed(0)}%). O que falta segue ` +
      'no aviso de cobertura.';
  } else {
    verdict =
      'PODE LIGAR — ligada, o gasto do Smart+ bate com o da campanha ' +
      `(±${SPEND_TOLERANCE * 100}%) e a leitura é completa.`;
  }

  console.log(`\nComparação: ${verdict}\n`);
}

async function main() {
  const args = parseArgs();
  const secret = process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) {
    throw new Error('INTEGRATION_TOKEN_ENCRYPTION_KEY ausente ou curta.');
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    const account = await resolveAccount(prisma, args);
    const token = decrypt(account.integration.accessToken, secret);
    const reader = new TikTokReader(token, account.externalAccountId);
    const window = { start: isoDay(args.days), end: isoDay(1) };

    console.log(
      `\nConta: ${account.name} (advertiser ${account.externalAccountId})` +
        `\nIntegração: ${account.integration.status}` +
        `\nJanela de gasto: ${window.start} a ${window.end}\n`,
    );

    // 1. As campanhas Smart+, pela rota própria.
    const smart = await reader.list<CampaignNode>('/smart_plus/campaign/get/');
    if (!smart.ok) {
      console.log(`1. /smart_plus/campaign/get/ ${describeFailure(smart)}`);
      console.log(
        '\nVeredito: INCONCLUSIVO — a rota do Smart+ recusou. Confira se o app ' +
          'tem o escopo de gestão de campanhas e se a conta usa Smart+.',
      );
      return;
    }

    const smartIds = smart.items
      .map((campaign) => campaign.campaign_id)
      .filter((id): id is string => Boolean(id));

    console.log(`1. Campanhas Smart+ pela rota própria: ${smartIds.length}`);
    for (const campaign of smart.items.slice(0, 10)) {
      console.log(
        `   - ${campaign.campaign_id} · ${campaign.campaign_name ?? '(sem nome)'} · ${campaign.operation_status ?? campaign.secondary_status ?? '—'}`,
      );
    }

    if (smartIds.length === 0) {
      console.log(
        '\nVeredito: SEM SMART+ — a conta não tem campanha Smart+. Rode de ' +
          'novo numa conta que tenha pelo menos uma, com entrega no período.',
      );
      return;
    }

    // 2. As rotas padrão — as que o provider lê — enxergam essas campanhas?
    const standardCampaigns = await reader.listByIds<CampaignNode>(
      '/campaign/get/',
      'campaign_ids',
      smartIds,
    );
    const standardAdGroups = await reader.listByIds<{ adgroup_id?: string }>(
      '/adgroup/get/',
      'campaign_ids',
      smartIds,
    );
    const standardAds = await reader.listByIds<AdNode>(
      '/ad/get/',
      'campaign_ids',
      smartIds,
    );
    const smartAds = await reader.listByIds<AdNode>(
      '/smart_plus/ad/get/',
      'campaign_ids',
      smartIds,
    );

    const count = (result: CallResult<unknown>) =>
      result.ok ? String(result.items.length) : describeFailure(result);

    console.log(
      `2. Pelas rotas padrão, das ${smartIds.length} campanhas Smart+:`,
    );
    console.log(`   - /campaign/get/ devolveu: ${count(standardCampaigns)}`);
    console.log(
      `   - /adgroup/get/ devolveu grupos: ${count(standardAdGroups)}`,
    );
    console.log(`   - /ad/get/ devolveu anúncios: ${count(standardAds)}`);
    console.log(
      `   - /smart_plus/ad/get/ devolveu anúncios: ${count(smartAds)}`,
    );

    if (standardCampaigns.ok && standardCampaigns.items[0]) {
      // As chaves, não os valores: é o que diz se a rota padrão marca o Smart+.
      console.log(
        `   - campos da campanha na rota padrão: ${Object.keys(standardCampaigns.items[0]).sort().join(', ')}`,
      );
    }

    // 3. O relatório padrão cobre o gasto delas por anúncio?
    const campaignSpend = await reader.spend(
      'AUCTION_CAMPAIGN',
      'campaign_id',
      smartIds,
      window,
    );
    const adSpend = await reader.spend('AUCTION_AD', 'ad_id', smartIds, window);

    const byCampaign = campaignSpend.ok ? sumSpend(campaignSpend.items) : null;
    const byAd = adSpend.ok ? sumSpend(adSpend.items) : null;

    console.log('3. Gasto no período (relatório padrão):');
    console.log(
      `   - por campanha: ${campaignSpend.ok ? byCampaign!.toFixed(2) : describeFailure(campaignSpend)}`,
    );
    console.log(
      `   - soma por anúncio: ${adSpend.ok ? byAd!.toFixed(2) : describeFailure(adSpend)}`,
    );

    // 4. O que a Allva já tem delas.
    const stored = await prisma.campaign.findMany({
      where: {
        adAccountId: account.id,
        externalCampaignId: { in: smartIds },
      },
      select: {
        externalCampaignId: true,
        _count: { select: { ads: { where: { archivedAt: null } } } },
      },
    });
    const storedAds = stored.reduce((sum, c) => sum + c._count.ads, 0);
    console.log(
      `4. No banco da Allva: ${stored.length} das ${smartIds.length} campanhas, ${storedAds} anúncios ativos sob elas.`,
    );

    // Veredito.
    const campaignsSeen =
      standardCampaigns.ok &&
      smartIds.every((id) =>
        standardCampaigns.items.some((c) => c.campaign_id === id),
      );
    const adsSeen = standardAds.ok && standardAds.items.length > 0;
    const spendCovered =
      byCampaign !== null &&
      byAd !== null &&
      (byCampaign === 0 || byAd >= byCampaign * (1 - SPEND_TOLERANCE));

    let verdict: string;
    if (campaignsSeen && adsSeen && spendCovered) {
      verdict =
        'COBERTO — as rotas padrão devolvem as campanhas, os anúncios e o gasto ' +
        'por anúncio do Smart+. O provider já os analisa; ligar a leitura Smart+ ' +
        'só troca a representação (o criativo vira o pacote inteiro), sem mudar ' +
        'o gasto.';
    } else if (!standardCampaigns.ok || !standardAds.ok) {
      verdict =
        'INCONCLUSIVO — uma rota padrão recusou a leitura. Veja as recusas acima.';
    } else if (
      standardCampaigns.items.length === 0 &&
      standardAds.items.length === 0
    ) {
      verdict =
        'NÃO COBERTO — as rotas padrão não enxergam o Smart+. A leitura pelas ' +
        'rotas próprias (TIKTOK_SMART_PLUS_ENABLED) é necessária: confira com ' +
        '--compare antes de ligar.';
    } else {
      verdict =
        'PARCIAL — as rotas padrão enxergam parte do Smart+ (veja qual acima). ' +
        'O que falta vem da leitura pelas rotas próprias ' +
        '(TIKTOK_SMART_PLUS_ENABLED): confira com --compare antes de ligar.';
    }

    console.log(`\nVeredito: ${verdict}\n`);

    if (args.compare) {
      await compareProvider({
        token,
        advertiserId: account.externalAccountId,
        currency: account.currency,
        days: args.days,
        smartIds,
        campaignSpend: byCampaign,
      });
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  // A mensagem nunca carrega o token: ele só existe no cabeçalho da chamada.
  console.error(`\nFalhou: ${(error as Error).message}\n`);
  process.exit(1);
});
