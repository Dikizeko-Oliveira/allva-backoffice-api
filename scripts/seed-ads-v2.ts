/**
 * Seed do domínio ads-first (A2-S1, entrega 9).
 *
 * Popula organização → conta de anúncios → campanhas → conjuntos → anúncios →
 * criativos → série de `ad_metric_snapshots`, com **moeda dupla** (R-M) e
 * **linhagem** (§3.6). É o que destrava A2-S2 sem depender do sync real, que só
 * existe em A2-S3: sem ele, `GET /ads` nasceria contra uma tabela vazia e o p95
 * do gate seria medido sobre nada.
 *
 * Três contas de anúncios, uma por plataforma, todas na mesma organização —
 * é o que exercita "várias plataformas, mesma organização" em toda a cadeia
 * (scoring, waste, recomendações), que já é agnóstica de plataforma e opera
 * por `adAccountId`/`organizationId` (nunca filtra por `platform`):
 *   - META:    3 campanhas, 2 conjuntos/campanha, 12 criativos, `--ads` anúncios
 *   - GOOGLE:  2 campanhas — Pesquisa com 2 conjuntos e `--ads` anúncios, e
 *              Performance Max com 3 grupos de recursos (sem conjunto, D23)
 *   - TIKTOK:  2 campanhas, 2 conjuntos/campanha,  8 criativos, `--ads` anúncios
 *
 * `--ads` é **padronizado e uniforme entre as três** (default 30 cada, 90 no
 * total). Antes só a Meta era parametrizável e Google/TikTok tinham volume
 * fixo (60/70) — assimetria sem motivo de negócio, que só tornava o total
 * imprevisível para quem lia o comando sem abrir este arquivo.
 *
 * Uso:
 *   pnpm seed:ads-v2 -- --owner=voce@exemplo.com   # 30 dias, 90 anúncios (30+30+30)
 *   pnpm seed:ads-v2 -- --org=<id>
 *   pnpm seed:ads-v2 -- --org=<id> --days=45 --ads=100  # 100 anúncios em CADA plataforma
 *   pnpm seed:ads-v2 -- --org=<id> --reset         # apaga o do seed e refaz
 *   pnpm seed:ads-v2 -- --org=<id> --reset-only
 *
 * Com uma organização só no banco os dois seletores são dispensáveis. Com mais
 * de uma o script para e lista, em vez de escolher: ver `resolveOrganization`.
 *
 * ## Integração fake — mudança de comportamento
 *
 * Até aqui o seed nunca criava `Integration`: a credencial é dado real e o
 * script não inventa nenhuma. Mas desde `ab0e902` ("Varredura de acesso
 * fechado nos jobs de sync e scoring"), `analysis-scope`/`ad-scoring`/`waste`
 * só enxergam conta cujo `AdAccount.integrationId` aponte para uma
 * `Integration` com status sincronizável — e sem ela `dev:chain` roda sobre
 * zero contas, sempre, não importa quanto dado exista. Por pedido explícito,
 * o seed agora cria uma `Integration` **obviamente fake** por plataforma
 * (`accessToken`/`refreshToken` são strings marcadas, nunca decodificáveis
 * contra a API real) e a vincula à `AdAccount`, só para satisfazer esse gate.
 *
 * Duas consequências de deixar de ser credential-less, e que valem saber antes
 * de rodar:
 *   - **Fica visível**: esta `Integration` aparece em qualquer tela ou consulta
 *     que liste as integrações da organização (ex.: Configurações), com nome
 *     começando em `seed-` e `(FAKE)` de propósito, para não passar por uma
 *     conexão real.
 *   - **Se algo tentar sincronizar de verdade** (um worker de `ads-ingest-full`
 *     rodando à parte, fora deste script) vai chamar a API real da plataforma
 *     com um token inválido e falhar (401) — esperado, e o pior caso é o
 *     status virar `ERROR` (ainda sincronizável) ou, mais raro, `TOKEN_EXPIRED`
 *     (aí só `--reset` religa).
 *
 * Segurança: só toca linhas cujo id externo (ou, para `Integration`, cujo nome)
 * começa com `seed-`.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { Platform } from '../generated/prisma/enums';

const SEED_PREFIX = 'seed-';
const DEFAULT_DAYS = 30;
/** Padronizado entre as três plataformas — ver cabeçalho do arquivo. */
const DEFAULT_ADS = 30;
const BASE_CURRENCY = 'BRL';
/** Conta em USD sob organização em BRL: é o que exercita a moeda dupla. */
const ACCOUNT_CURRENCY = 'USD';
const FX_RATE = 5.5;

type Args = {
  days: number;
  ads: number;
  reset: boolean;
  resetOnly: boolean;
  /** Id da organização alvo. */
  org?: string;
  /** E-mail do dono da organização alvo — o mesmo com que você loga. */
  owner?: string;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const value = (name: string) =>
    argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1];

  return {
    days: Number(value('days') ?? DEFAULT_DAYS),
    ads: Number(value('ads') ?? DEFAULT_ADS),
    reset: argv.includes('--reset'),
    resetOnly: argv.includes('--reset-only'),
    org: value('org'),
    owner: value('owner'),
  };
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

/** Gerador determinístico: o mesmo seed produz sempre os mesmos números. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(20260801);

function utcDay(offsetDays: number): Date {
  const now = new Date();
  const day = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - offsetDays,
  );
  return new Date(day);
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

const ORGANIZATION_FIELDS = {
  id: true,
  ownerId: true,
  name: true,
  baseCurrency: true,
  owner: { select: { email: true } },
} as const;

/**
 * A organização que vai receber o seed — **escolhida, nunca adivinhada**.
 *
 * A primeira redação pegava `findFirst` ordenado por `createdAt asc`, e num
 * banco com mais de uma organização isso é uma decisão silenciosa sobre onde
 * 220 anúncios vão parar. O sintoma não parece um erro: o seed conclui com ✅,
 * e quem loga na própria organização vê as telas vazias — indistinguível do
 * produto estar quebrado, que é o pior desfecho possível para um script cujo
 * propósito é justamente destravar o teste das telas.
 *
 * Com uma organização só, o comportamento é o de antes. Com várias, o script
 * **para e lista**: escolher errado custa um `--reset` e outra rodada; parar
 * custa uma linha de comando.
 */
async function resolveOrganization(args: Args) {
  if (args.org && args.owner) {
    throw new Error('Use `--org=<id>` ou `--owner=<email>`, não os dois.');
  }

  if (args.org) {
    const organization = await prisma.organization.findFirst({
      where: { id: args.org, deletedAt: null },
      select: ORGANIZATION_FIELDS,
    });

    if (!organization) {
      throw new Error(`Nenhuma organização ativa com id ${args.org}.`);
    }

    return organization;
  }

  if (args.owner) {
    const organizations = await prisma.organization.findMany({
      where: { deletedAt: null, owner: { email: args.owner } },
      orderBy: { createdAt: 'asc' },
      select: ORGANIZATION_FIELDS,
    });

    if (organizations.length === 0) {
      throw new Error(
        `Nenhuma organização ativa cujo dono seja ${args.owner}.`,
      );
    }

    // Uma conta pode ser dona de várias (o `@unique` de `ownerId` caiu de
    // propósito). Ambiguidade aqui merece o mesmo tratamento do caso geral.
    if (organizations.length > 1) {
      throw new Error(
        `${args.owner} é dono de ${organizations.length} organizações. ` +
          `Escolha pelo id:\n${describe(organizations)}`,
      );
    }

    return organizations[0];
  }

  const organizations = await prisma.organization.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: ORGANIZATION_FIELDS,
  });

  if (organizations.length === 0) {
    throw new Error(
      'Nenhuma organização encontrada. Crie uma conta e uma organização antes de rodar o seed.',
    );
  }

  if (organizations.length > 1) {
    throw new Error(
      `Há ${organizations.length} organizações no banco e o seed não escolhe por você.\n` +
        `${describe(organizations)}\n` +
        'Rode de novo com `--org=<id>` ou `--owner=<e-mail do dono>`.',
    );
  }

  return organizations[0];
}

function describe(
  organizations: { id: string; name: string; owner: { email: string } }[],
): string {
  return organizations
    .map((o) => `  --org=${o.id}   ${o.name} (dono: ${o.owner.email})`)
    .join('\n');
}

async function wipe(organizationId: string) {
  const adAccounts = await prisma.adAccount.findMany({
    where: { organizationId, externalAccountId: { startsWith: SEED_PREFIX } },
    select: { id: true },
  });
  const ids = adAccounts.map((account) => account.id);
  if (ids.length === 0) return;

  // Ordem de FK: a série cascateia com o anúncio, mas as demais não.
  await prisma.adMetricSnapshot.deleteMany({
    where: { adAccountId: { in: ids } },
  });
  await prisma.ad.deleteMany({ where: { adAccountId: { in: ids } } });
  await prisma.creative.deleteMany({ where: { adAccountId: { in: ids } } });
  await prisma.adSet.deleteMany({ where: { adAccountId: { in: ids } } });
  await prisma.campaign.deleteMany({ where: { adAccountId: { in: ids } } });
  await prisma.adAccount.deleteMany({ where: { id: { in: ids } } });

  // Só depois da conta: `AdAccount.integrationId` tem FK para `Integration`,
  // e apagar antes violaria a restrição.
  const integrations = await prisma.integration.deleteMany({
    where: { organizationId, name: { startsWith: FAKE_INTEGRATION_MARKER } },
  });

  console.log(
    `🧹 removidas ${ids.length} conta(s) de anúncios e ${integrations.count} integração(ões) fake do seed`,
  );
}

/**
 * `optimization` é o que o provider traduziria do objetivo real — sem ele, o
 * anúncio semeado cairia em "objetivo não identificado" e os detectores de
 * conversão ficariam mudos em dev. Conjunto herda da campanha, como no Google.
 */
type CampaignSpec = {
  name: string;
  objective: string;
  /**
   * Campanha sem anúncio: a unidade é o grupo de recursos (Performance Max,
   * D23). Não ganha conjunto nem anúncio — ganha `assetGroups` unidades, cada
   * uma com o próprio pacote de recursos como criativo.
   */
  assetGroups?: number;
  optimization: {
    optimizationClass: 'CONVERSION' | 'TRAFFIC' | 'AWARENESS' | 'ENGAGEMENT';
    conversionEvent: string | null;
    conversionMeasurable: boolean;
  };
};

const SALES = {
  optimizationClass: 'CONVERSION',
  conversionEvent: 'PURCHASE',
  conversionMeasurable: true,
} as const;

const AWARENESS = {
  optimizationClass: 'AWARENESS',
  conversionEvent: null,
  conversionMeasurable: false,
} as const;

const APP_INSTALLS = {
  optimizationClass: 'CONVERSION',
  conversionEvent: 'APP_INSTALL',
  conversionMeasurable: true,
} as const;

/**
 * Uma conta de anúncios inteira a semear. `idPrefix` entra nos ids externos
 * (`camp_1`, `adset_1_1`, ...) para não colidir *visualmente* entre contas —
 * a unicidade real de banco já é por `adAccountId`, então isto é só para quem
 * for ler a tabela direto não confundir plataformas.
 *
 * A Meta usa `idPrefix: ''` de propósito: são os mesmos ids externos de
 * sempre, para que rodar o seed de novo sobre uma organização já semeada
 * faça `upsert` nas linhas existentes em vez de duplicá-las.
 */
type PlatformSeedSpec = {
  platform: Platform;
  idPrefix: string;
  /** Valor de `Integration.provider` — minúsculo, como as conexões reais gravam. */
  providerSlug: string;
  externalAccountId: string;
  accountName: string;
  currency: string;
  campaigns: CampaignSpec[];
  adSetsPerCampaign: number;
  creativeCount: number;
  adCount: number;
};

function buildPlatformSpecs(args: Args): PlatformSeedSpec[] {
  return [
    {
      platform: Platform.META,
      idPrefix: '',
      providerSlug: 'meta',
      externalAccountId: `${SEED_PREFIX}act_1001`,
      accountName: 'Conta de desenvolvimento (seed)',
      currency: ACCOUNT_CURRENCY,
      campaigns: [
        {
          name: 'Aquisição — Prospecção',
          objective: 'OUTCOME_SALES',
          optimization: SALES,
        },
        {
          name: 'Remarketing — Carrinho',
          objective: 'OUTCOME_SALES',
          optimization: SALES,
        },
        {
          name: 'Topo — Vídeo',
          objective: 'OUTCOME_AWARENESS',
          optimization: AWARENESS,
        },
      ],
      adSetsPerCampaign: 2,
      creativeCount: 12,
      adCount: args.ads,
    },
    {
      platform: Platform.GOOGLE,
      idPrefix: 'google_',
      providerSlug: 'google',
      externalAccountId: `${SEED_PREFIX}google_act_2001`,
      accountName: 'Conta de desenvolvimento (seed) — Google',
      currency: ACCOUNT_CURRENCY,
      campaigns: [
        {
          name: 'Pesquisa — Palavras-chave',
          objective: 'SEARCH',
          optimization: SALES,
        },
        {
          name: 'Performance Max — Catálogo',
          objective: 'PERFORMANCE_MAX',
          assetGroups: 3,
          optimization: SALES,
        },
      ],
      adSetsPerCampaign: 2,
      creativeCount: 6,
      adCount: args.ads,
    },
    {
      platform: Platform.TIKTOK,
      idPrefix: 'tiktok_',
      providerSlug: 'tiktok',
      externalAccountId: `${SEED_PREFIX}tiktok_act_3001`,
      accountName: 'Conta de desenvolvimento (seed) — TikTok',
      currency: ACCOUNT_CURRENCY,
      campaigns: [
        {
          name: 'Vídeo Curto — Awareness',
          objective: 'REACH',
          optimization: AWARENESS,
        },
        {
          name: 'Conversão — App Install',
          objective: 'APP_PROMOTION',
          optimization: APP_INSTALLS,
        },
      ],
      adSetsPerCampaign: 2,
      creativeCount: 8,
      adCount: args.ads,
    },
  ];
}

/** Marca toda `Integration` fake do seed — nunca uma credencial de verdade. */
const FAKE_INTEGRATION_MARKER = `${SEED_PREFIX}FAKE`;

/**
 * Acha ou cria a `Integration` fake da plataforma, e devolve o id para ligar
 * em `AdAccount`/`Campaign`/`Ad`.
 *
 * **Não usa `id` literal como chave de upsert** — ao contrário das outras
 * entidades do seed, `Integration` não tem uma coluna de id externo natural
 * para compor uma constraint única, e usar uma string fixa feriria o `id`
 * (chave primária global): duas organizações rodando o seed colidiriam na
 * mesma linha e uma "roubaria" a integração da outra. Por isso é busca por
 * `organizationId` + `provider` + o marcador em `name`, e cria só se não achar.
 *
 * `accessToken`/`refreshToken` nunca são um token de verdade: o cifrador
 * (`TokenCipherService`) trata payload sem o prefixo `v1:` como "token legado
 * em texto puro" e o devolve como está — não lança erro ao tentar decifrar,
 * só loga um aviso. É por isso que uma string óbvia funciona aqui sem precisar
 * replicar a cifra AES-GCM da aplicação dentro de um script solto.
 */
async function resolveSeedIntegration(
  organization: { id: string; ownerId: string },
  spec: PlatformSeedSpec,
): Promise<{ id: string }> {
  const name = `${FAKE_INTEGRATION_MARKER} — ${spec.platform} (seed, não é uma conexão real)`;

  const existing = await prisma.integration.findFirst({
    where: {
      organizationId: organization.id,
      provider: spec.providerSlug,
      name: { startsWith: FAKE_INTEGRATION_MARKER },
    },
    select: { id: true },
  });

  // Data bem longe: evita qualquer fluxo de "token perto de expirar" tentando
  // renovar uma credencial que não existe.
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

  if (existing) {
    await prisma.integration.update({
      where: { id: existing.id },
      data: { status: 'CONNECTED', disconnectedAt: null, expiresAt },
    });
    return existing;
  }

  return prisma.integration.create({
    data: {
      accountId: organization.ownerId,
      organizationId: organization.id,
      name,
      provider: spec.providerSlug,
      providerType: spec.platform,
      accessToken: `${FAKE_INTEGRATION_MARKER}-access-token-${spec.idPrefix || 'meta_'}`,
      refreshToken: `${FAKE_INTEGRATION_MARKER}-refresh-token-${spec.idPrefix || 'meta_'}`,
      expiresAt,
      status: 'CONNECTED',
      syncStatus: 'IDLE',
    },
    select: { id: true },
  });
}

type SeededCampaign = {
  campaign: { id: string };
  adSets: { id: string }[];
  spec: CampaignSpec;
};

type SeededAd = {
  id: string;
  campaignId: string;
  /** Nulo no grupo de recursos, que pende direto da campanha. */
  adSetId: string | null;
  creativeId: string;
  /** Do criativo herdado — decide se a linha de série ganha sinal de vídeo. */
  creativeFormat: string | null;
};

const NO_MEDIA = { thumbnailUrl: null, videoUrl: null } as const;

/**
 * `thumbnailUrl`/`videoUrl` do criativo de vídeo — espelhando o que cada
 * plataforma de fato entrega hoje, depois da correção de captura de
 * miniatura/hook (ver `TikTokAdsProvider`/`MetaAdsProvider`/`GoogleAdsProvider`).
 *
 * Sem isto, todo criativo `VIDEO` do seed ficava com os dois campos `null` —
 * o que é o comportamento real do Google, mas **não** o da Meta nem o do
 * TikTok, que resolvem miniatura. Um seed que trata os três como o Google
 * escondia a diferença que motivou a correção, e a tela de criativos nunca
 * mostrava uma imagem para nenhum vídeo local.
 *
 * O Google continua `null`/`null` de propósito: `video_responsive_ad` não tem
 * campo de imagem, e `videoUrl` seria um resource name, não um endereço — é o
 * mesmo motivo documentado em `GoogleAdsProvider.toCreative`, não uma omissão
 * deste seed.
 */
function videoMediaFor(
  platform: Platform,
  c: number,
): { thumbnailUrl: string | null; videoUrl: string | null } {
  if (platform === Platform.GOOGLE) return NO_MEDIA;

  return {
    thumbnailUrl: `https://picsum.photos/seed/${platform.toLowerCase()}-${c}/400/300`,
    // O TikTok resolve `preview_url` de verdade (D7); a Meta grava o
    // `video_id` cru, que não é URL. Nenhum dos dois precisa ser buscável
    // aqui — só o backfill de ffmpeg tentaria, e só quando `thumbnailUrl`
    // falta, que não é o caso de nenhum dos dois acima.
    videoUrl:
      platform === Platform.TIKTOK
        ? `https://example-cdn.test/tiktok-preview/${c}.mp4`
        : null,
  };
}

/**
 * Metade curta, metade longa — sem isto todo criativo do seed tinha os mesmos
 * 34 caracteres, e `suggestCopyChanges` disparava `THIN_BODY` em **100%** dos
 * anúncios, sempre a mesma sugestão, disfarçando qualquer suggestion baseada
 * em desempenho (`WEAK_HOOK`, `NEGATIVE_FEEDBACK_RISK`, `WEAK_CTA`...).
 */
function bodyFor(c: number): string {
  if (c % 2 === 0) return 'Texto de anúncio gerado pelo seed.';

  return (
    'Texto de anúncio gerado pelo seed, com o resultado concreto que a ' +
    'oferta entrega e uma prova numérica de que ele acontece de verdade.'
  );
}

/** Semeia uma conta de anúncios inteira (campanhas → conjuntos → criativos →
 * anúncios → série de métricas) para uma plataforma. */
async function seedPlatformAccount(
  organization: { id: string; ownerId: string },
  spec: PlatformSeedSpec,
  days: number,
): Promise<{
  campaigns: number;
  adSets: number;
  creatives: number;
  ads: number;
  rows: number;
}> {
  const integration = await resolveSeedIntegration(organization, spec);

  const adAccount = await prisma.adAccount.upsert({
    where: {
      organizationId_platform_externalAccountId: {
        organizationId: organization.id,
        platform: spec.platform,
        externalAccountId: spec.externalAccountId,
      },
    },
    // `update` (não só `create`): uma conta semeada ANTES da integração fake
    // existir precisa ganhar o vínculo ao rodar de novo, sem precisar de
    // `--reset` — senão ela ficaria permanentemente fora do gate de varredura.
    update: { integrationId: integration.id },
    create: {
      accountId: organization.ownerId,
      organizationId: organization.id,
      platform: spec.platform,
      externalAccountId: spec.externalAccountId,
      name: spec.accountName,
      integrationId: integration.id,
      currency: spec.currency,
      timezone: 'America/Sao_Paulo',
      attributionWindowDays: 7,
      restatementWindowDays: 14,
      lastSuccessfulFullSyncAt: new Date(),
    },
  });

  const campaigns: SeededCampaign[] = [];
  for (const [index, campaignSpec] of spec.campaigns.entries()) {
    const campaign = await prisma.campaign.upsert({
      where: {
        adAccountId_externalCampaignId: {
          adAccountId: adAccount.id,
          externalCampaignId: `${SEED_PREFIX}${spec.idPrefix}camp_${index + 1}`,
        },
      },
      // O objetivo traduzido entra também no `update`: organização semeada
      // antes desta coluna existir passa a tê-lo ao rodar o seed de novo.
      update: { ...campaignSpec.optimization },
      create: {
        adAccountId: adAccount.id,
        organizationId: organization.id,
        integrationId: integration.id,
        platform: spec.platform,
        externalCampaignId: `${SEED_PREFIX}${spec.idPrefix}camp_${index + 1}`,
        name: campaignSpec.name,
        status: 'ACTIVE',
        objective: campaignSpec.objective,
        ...campaignSpec.optimization,
        dailyBudget: 500 + index * 250,
        currency: spec.currency,
        startedAt: utcDay(60),
      },
    });

    const adSets: { id: string }[] = [];
    // Performance Max não tem conjunto: a unidade é o grupo de recursos.
    const adSetCount = campaignSpec.assetGroups ? 0 : spec.adSetsPerCampaign;
    for (let s = 1; s <= adSetCount; s += 1) {
      adSets.push(
        await prisma.adSet.upsert({
          where: {
            adAccountId_externalAdSetId: {
              adAccountId: adAccount.id,
              externalAdSetId: `${SEED_PREFIX}${spec.idPrefix}adset_${index + 1}_${s}`,
            },
          },
          update: { ...campaignSpec.optimization },
          create: {
            adAccountId: adAccount.id,
            organizationId: organization.id,
            campaignId: campaign.id,
            platform: spec.platform,
            externalAdSetId: `${SEED_PREFIX}${spec.idPrefix}adset_${index + 1}_${s}`,
            name: `${campaignSpec.name} — conjunto ${s}`,
            status: 'ACTIVE',
            optimizationGoal: 'OFFSITE_CONVERSIONS',
            ...campaignSpec.optimization,
            dailyBudget: 250,
          },
        }),
      );
    }

    campaigns.push({ campaign, adSets, spec: campaignSpec });
  }

  // Criativos compartilhados entre anúncios: é o que torna a comparação "mesmo
  // criativo, desempenhos diferentes" possível de exercitar (§11.3), e o que
  // `OVERLAPPING_DELIVERY` procura por `contentHash` (D14).
  const creatives: { id: string; format: string }[] = [];
  for (let c = 1; c <= spec.creativeCount; c += 1) {
    const format = c % 3 === 0 ? 'VIDEO' : 'IMAGE';
    const media =
      format === 'VIDEO' ? videoMediaFor(spec.platform, c) : NO_MEDIA;

    const creative = await prisma.creative.upsert({
      where: {
        adAccountId_externalCreativeId: {
          adAccountId: adAccount.id,
          externalCreativeId: `${SEED_PREFIX}${spec.idPrefix}creative_${c}`,
        },
      },
      update: {},
      create: {
        adAccountId: adAccount.id,
        organizationId: organization.id,
        platform: spec.platform,
        externalCreativeId: `${SEED_PREFIX}${spec.idPrefix}creative_${c}`,
        name: `Criativo ${c}`,
        title: `Headline ${c}`,
        body: bodyFor(c),
        callToAction: c % 2 === 0 ? 'SHOP_NOW' : 'LEARN_MORE',
        format,
        durationMs: format === 'VIDEO' ? 15000 : null,
        thumbnailUrl: media.thumbnailUrl,
        videoUrl: media.videoUrl,
        // Dois criativos compartilham hash de propósito.
        contentHash: `hash-${spec.idPrefix}${Math.ceil(c / 2)}`,
      },
    });

    creatives.push({ id: creative.id, format });
  }

  const adSetTotal = campaigns.reduce((sum, c) => sum + c.adSets.length, 0);
  console.log(
    `📦 ${spec.platform}: ${campaigns.length} campanhas, ${adSetTotal} conjuntos, ${creatives.length} criativos`,
  );

  // Anúncio só existe em campanha com conjunto; a de grupos de recursos recebe
  // as próprias unidades logo abaixo.
  const adCampaigns = campaigns.filter((c) => c.adSets.length > 0);

  const ads: SeededAd[] = [];
  for (let i = 1; i <= spec.adCount; i += 1) {
    const bucket = adCampaigns[i % adCampaigns.length];
    const adSet = bucket.adSets[i % bucket.adSets.length];
    const creative = creatives[i % creatives.length];
    const externalAdId = `${SEED_PREFIX}${spec.idPrefix}ad_${i}`;

    const ad = await prisma.ad.upsert({
      where: {
        adAccountId_externalAdId: { adAccountId: adAccount.id, externalAdId },
      },
      update: {},
      create: {
        accountId: organization.ownerId,
        organizationId: organization.id,
        adAccountId: adAccount.id,
        integrationId: integration.id,
        platform: spec.platform,
        externalAdId,
        campaignId: bucket.campaign.id,
        adSetId: adSet.id,
        creativeId: creative.id,
        name: `Anúncio ${i}`,
        // `lineageId` recebe o próprio id logo abaixo: todo anúncio pertence a
        // exatamente uma linhagem (I6), e a dele começa nele mesmo.
        lineageId: 'pending',
        observedStatus: i % 9 === 0 ? 'PAUSED' : 'ACTIVE',
        observedAsOf: new Date(),
        syncState: 'IN_SYNC',
        syncStateAt: new Date(),
        dataMaturity: 'MATURE',
        lastStructureSyncAt: new Date(),
        lastMetricsSyncAt: new Date(),
      },
    });

    if (ad.lineageId === 'pending') {
      await prisma.ad.update({
        where: { id: ad.id },
        data: { lineageId: ad.id },
      });
    }

    ads.push({
      id: ad.id,
      campaignId: bucket.campaign.id,
      adSetId: adSet.id,
      creativeId: creative.id,
      creativeFormat: creative.format,
    });
  }

  console.log(`📢 ${spec.platform}: ${ads.length} anúncios`);

  // Grupos de recursos: a unidade do Performance Max (D23). Sem conjunto, com
  // um pacote de recursos próprio como criativo, e id externo prefixado como o
  // provider do Google grava.
  let assetGroupCount = 0;
  for (const [index, bucket] of campaigns.entries()) {
    for (let g = 1; g <= (bucket.spec.assetGroups ?? 0); g += 1) {
      const unitExternalId = `asset_group:${SEED_PREFIX}${spec.idPrefix}${index + 1}_${g}`;

      const creative = await prisma.creative.upsert({
        where: {
          adAccountId_externalCreativeId: {
            adAccountId: adAccount.id,
            externalCreativeId: unitExternalId,
          },
        },
        update: {},
        create: {
          adAccountId: adAccount.id,
          organizationId: organization.id,
          platform: spec.platform,
          externalCreativeId: unitExternalId,
          name: `Grupo de recursos ${g}`,
          title: `Headline do grupo ${g}`,
          body: bodyFor(g),
          callToAction: 'SHOP_NOW',
          format: 'PERFORMANCE_MAX',
          contentHash: `hash-${spec.idPrefix}asset-group-${index + 1}-${g}`,
          metadata: {
            // A classificação do Google por recurso, como o provider grava:
            // um de cada, para a tela ter o que mostrar.
            copyAssets: {
              headlines: (['BEST', 'GOOD', 'LOW'] as const).map(
                (performanceLabel, h) => ({
                  index: h,
                  text: `Headline ${h + 1} do grupo ${g}`,
                  pinnedField: null,
                  performanceLabel,
                }),
              ),
              descriptions: [
                {
                  index: 0,
                  text: bodyFor(g),
                  pinnedField: null,
                  performanceLabel: 'LEARNING',
                },
              ],
              longHeadlines: [
                {
                  index: 0,
                  text: `Título longo do grupo ${g}, com a oferta inteira`,
                  pinnedField: null,
                  performanceLabel: null,
                },
              ],
            },
            adStrength: g === 1 ? 'EXCELLENT' : 'GOOD',
          },
        },
      });

      const unit = await prisma.ad.upsert({
        where: {
          adAccountId_externalAdId: {
            adAccountId: adAccount.id,
            externalAdId: unitExternalId,
          },
        },
        update: {},
        create: {
          accountId: organization.ownerId,
          organizationId: organization.id,
          adAccountId: adAccount.id,
          integrationId: integration.id,
          platform: spec.platform,
          externalAdId: unitExternalId,
          campaignId: bucket.campaign.id,
          adSetId: null,
          unitKind: 'ASSET_GROUP',
          creativeId: creative.id,
          name: `${bucket.spec.name} — grupo ${g}`,
          lineageId: 'pending',
          observedStatus: 'ACTIVE',
          observedAsOf: new Date(),
          syncState: 'IN_SYNC',
          syncStateAt: new Date(),
          dataMaturity: 'MATURE',
          lastStructureSyncAt: new Date(),
          lastMetricsSyncAt: new Date(),
        },
      });

      if (unit.lineageId === 'pending') {
        await prisma.ad.update({
          where: { id: unit.id },
          data: { lineageId: unit.id },
        });
      }

      ads.push({
        id: unit.id,
        campaignId: bucket.campaign.id,
        adSetId: null,
        creativeId: creative.id,
        creativeFormat: 'PERFORMANCE_MAX',
      });
      assetGroupCount += 1;
    }
  }

  if (assetGroupCount > 0) {
    console.log(`🧩 ${spec.platform}: ${assetGroupCount} grupos de recursos`);
  }

  // Um par derivado: o segundo anúncio herda a linhagem do primeiro, como se
  // tivesse nascido de um REPLACE_COPY. É o que permite testar em S2 que a série
  // atravessa a recriação em vez de recomeçar do zero.
  if (ads.length >= 2) {
    await prisma.ad.update({
      where: { id: ads[1].id },
      data: { lineageId: ads[0].id, originAdId: ads[0].id },
    });
  }

  let rows = 0;
  for (const [index, ad] of ads.entries()) {
    // Perfis distintos para o detector ter o que encontrar em S5: campeão,
    // mediano, gastador sem conversão e anúncio fatigado.
    const profile = index % 4;
    const data = [] as {
      id: string;
      adId: string;
      organizationId: string;
      adAccountId: string;
      platform: Platform;
      date: Date;
      campaignId: string;
      adSetId: string | null;
      creativeId: string;
      spend: number;
      impressions: number;
      clicks: number;
      conversions: number;
      revenue: number;
      frequency: number;
      // Vídeo (attention, §12.3): só quando o criativo é `VIDEO` — um
      // estático nunca gera este sinal, em plataforma nenhuma (§12.4, dívida
      // B7-bis). `undefined` omite a coluna (fica `NULL`), nunca `0`.
      videoViews?: number;
      engagement?: number;
      thumbstopRate?: number;
      holdRate?: number;
      // Alcance: só Meta e TikTok declaram (`PlatformProfile`); Search do
      // Google não tem alcance deduplicado.
      reach?: number;
      // Feedback negativo: só a Meta expõe (`post_hide`/`post_report_spam`/…
      // no Graph). Google e TikTok ficam sem estes quatro campos, como na
      // sincronização real.
      hides?: number;
      hideAllFor?: number;
      reports?: number;
      unlikes?: number;
      currency: string;
      baseCurrency: string;
      spendBase: number;
      revenueBase: number;
      fxRate: number;
      fxAsOf: Date;
      fxSource: string;
      accountTimezone: string;
      attributionSetting: string;
    }[];

    const isVideo = ad.creativeFormat === 'VIDEO';
    const hasReach = spec.platform !== Platform.GOOGLE;
    const hasNegativeFeedback = spec.platform === Platform.META;
    // Perfil 1 (mediano) é quem carrega o risco: números de desempenho
    // comuns, mas com feedback negativo alto — o caso que `NEGATIVE_FEEDBACK_
    // RISK` existe para separar de "corpo curto" ou "hook fraco".
    const riskyFeedback = profile === 1;
    // Atenção por perfil: campeão prende, gastador sem conversão não prende
    // ninguém — a mesma lógica de variedade que os outros sinais já usam.
    const thumbstopBase = [0.32, 0.2, 0.09, 0.22][profile];
    const holdBase = [0.4, 0.25, 0.12, 0.24][profile];

    for (let d = days - 1; d >= 0; d -= 1) {
      const date = utcDay(d);
      const noise = 0.85 + random() * 0.3;
      const spend = round((profile === 2 ? 90 : 35) * noise);
      const impressions = Math.round(
        spend * (profile === 3 ? 60 : 110) * noise,
      );
      const clicks = Math.round(impressions * (profile === 0 ? 0.028 : 0.011));
      const conversions =
        profile === 2 ? 0 : Math.max(0, Math.round(clicks * 0.06 * noise));
      const revenue = round(conversions * (profile === 0 ? 180 : 95));
      // Fadiga: frequência subindo ao longo da janela no perfil 3.
      const frequency = round(
        profile === 3 ? 1.4 + (days - d) * 0.06 : 1.2 + random() * 0.3,
      );

      data.push({
        id: crypto.randomUUID(),
        adId: ad.id,
        organizationId: organization.id,
        adAccountId: adAccount.id,
        platform: spec.platform,
        date,
        campaignId: ad.campaignId,
        adSetId: ad.adSetId,
        creativeId: ad.creativeId,
        spend,
        impressions,
        clicks,
        conversions,
        revenue,
        frequency,
        videoViews: isVideo ? Math.round(impressions * 0.35) : undefined,
        engagement: isVideo ? Math.round(clicks * 0.4) : undefined,
        thumbstopRate: isVideo ? round(thumbstopBase * noise) : undefined,
        holdRate: isVideo ? round(holdBase * noise) : undefined,
        reach: hasReach
          ? Math.round(impressions / Math.max(frequency, 1))
          : undefined,
        hides: hasNegativeFeedback
          ? Math.round(impressions * (riskyFeedback ? 0.0009 : 0.00005))
          : undefined,
        hideAllFor: hasNegativeFeedback
          ? Math.round(impressions * (riskyFeedback ? 0.0003 : 0.00001))
          : undefined,
        reports: hasNegativeFeedback
          ? Math.round(impressions * (riskyFeedback ? 0.0002 : 0.00001))
          : undefined,
        unlikes: hasNegativeFeedback
          ? Math.round(impressions * (riskyFeedback ? 0.0004 : 0.00002))
          : undefined,
        currency: spec.currency,
        baseCurrency: BASE_CURRENCY,
        // Dupla persistência com a taxa FIXADA na linha (M2): o seed grava a
        // taxa que usou, não uma referência a ser resolvida na leitura.
        spendBase: round(spend * FX_RATE),
        revenueBase: round(revenue * FX_RATE),
        fxRate: FX_RATE,
        fxAsOf: date,
        fxSource: 'seed',
        accountTimezone: 'America/Sao_Paulo',
        attributionSetting: '7d_click',
      });
    }

    await prisma.adMetricSnapshot.createMany({ data, skipDuplicates: true });
    rows += data.length;
  }

  console.log(`📈 ${spec.platform}: ${rows} linhas de série (${days} dias)`);

  return {
    campaigns: campaigns.length,
    adSets: adSetTotal,
    creatives: creatives.length,
    ads: ads.length,
    rows,
  };
}

/**
 * A cotação do seed em `fx_rates` — **só nas datas ainda sem cotação**.
 *
 * As linhas de série já carregam a taxa fixada (M2), mas quem converte na
 * leitura consulta `fx_rates`: o teto diário de `GET /analytics/budget-pacing`
 * sai da moeda da conta (USD) para a da organização (BRL) ali. Com
 * `FX_PROVIDER=none` a coleta nunca roda localmente, a tabela fica vazia e toda
 * campanha do seed saía do ritmo por falta de taxa.
 *
 * Grava `USD → BRL` porque o conversor lê taxas a partir do pivô, e o pivô
 * padrão (`FX_PIVOT_CURRENCY`) é USD. Nunca grava ao lado de cotação existente,
 * de fonte nenhuma: o conversor escolhe por data, não por fonte, e uma taxa
 * `seed` junto de uma real (staging) poderia ser a escolhida. Fica fora do
 * `--reset` pelo mesmo motivo — `fx_rates` não é de organização nenhuma.
 */
async function seedFxRates(days: number) {
  const existing = await prisma.fxRate.findMany({
    where: {
      fromCurrency: ACCOUNT_CURRENCY,
      toCurrency: BASE_CURRENCY,
      date: { gte: utcDay(days - 1) },
    },
    select: { date: true },
  });
  const covered = new Set(
    existing.map((row) => row.date.toISOString().slice(0, 10)),
  );

  const data = [] as {
    date: Date;
    fromCurrency: string;
    toCurrency: string;
    rate: number;
    source: string;
  }[];
  for (let d = days - 1; d >= 0; d -= 1) {
    const date = utcDay(d);
    if (covered.has(date.toISOString().slice(0, 10))) continue;
    data.push({
      date,
      fromCurrency: ACCOUNT_CURRENCY,
      toCurrency: BASE_CURRENCY,
      rate: FX_RATE,
      source: 'seed',
    });
  }

  if (data.length > 0) {
    await prisma.fxRate.createMany({ data, skipDuplicates: true });
  }

  console.log(
    `💱 ${data.length} cotação(ões) ${ACCOUNT_CURRENCY}→${BASE_CURRENCY} gravadas (${covered.size} dia(s) já cotados)`,
  );
}

async function main() {
  const args = parseArgs();
  const organization = await resolveOrganization(args);

  console.log(
    `🎯 organização alvo: ${organization.name} (${organization.id}) — dono ${organization.owner.email}`,
  );

  if (args.reset || args.resetOnly) await wipe(organization.id);
  if (args.resetOnly) return;

  // Uma organização precisa de moeda-base e de configuração de ads para a
  // inteligência ter janela e versões ativas de onde ler (D16).
  await prisma.organization.update({
    where: { id: organization.id },
    data: { baseCurrency: BASE_CURRENCY },
  });
  await prisma.organizationAdsSettings.upsert({
    where: { organizationId: organization.id },
    update: {},
    create: { organizationId: organization.id },
  });
  await seedFxRates(args.days);

  const specs = buildPlatformSpecs(args);
  const totals = { campaigns: 0, adSets: 0, creatives: 0, ads: 0, rows: 0 };

  for (const spec of specs) {
    const result = await seedPlatformAccount(organization, spec, args.days);
    totals.campaigns += result.campaigns;
    totals.adSets += result.adSets;
    totals.creatives += result.creatives;
    totals.ads += result.ads;
    totals.rows += result.rows;
  }

  console.log(
    `\n📊 total: ${specs.length} contas, ${totals.campaigns} campanhas, ${totals.adSets} conjuntos, ` +
      `${totals.creatives} criativos, ${totals.ads} anúncios, ${totals.rows} linhas de série`,
  );
  console.log(
    `✅ seed concluído para a organização ${organization.id} (base ${BASE_CURRENCY}, conta ${ACCOUNT_CURRENCY})`,
  );
}

main()
  .catch((error) => {
    console.error('❌ seed falhou:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
