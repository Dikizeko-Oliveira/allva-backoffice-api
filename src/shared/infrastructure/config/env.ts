import { z } from 'zod';
import { findProductionBlockers } from './config-readiness';

/**
 * A required field here means "the process refuses to boot without it". Which
 * variables earn that, and which must degrade with a log instead, is specified in
 * `docs/env-secrets.md` (PLAN.md Sprint 5.5 / P-6).
 *
 * Three tiers, and all three are enforced:
 *
 * 1. **Critical** — non-optional below, so `parse` fails without it.
 * 2. **Conditionally critical** — optional below, required in production by the
 *    `superRefine` at the bottom of this file (billing webhook secrets).
 * 3. **Optional** — reported at boot by `ConfigReadinessService`, never fatal.
 *
 * `docs/env-secrets.md` records how each variable was classified (D-1 … D-5).
 * Read it before promoting or demoting anything below. Note that `EnvService.get`
 * returns `Env[K]`, so making a variable optional here **does** surface as a type
 * error at every call site that assumed a value — that is the point, and it is
 * how D-2 found the seven unchecked uses in `meta-ads.provider.ts`.
 */
const envShape = z.object({
  DATABASE_URL: z.url(),
  // Hard requirement: a weak/short JWT signing key fails startup. 32 bytes is
  // the minimum for the HS256 signing used by the JWT provider.
  JWT_SECRET_KEY: z
    .string()
    .min(32, 'JWT_SECRET_KEY must be at least 32 characters'),
  // Not a secret and not an infra decision, so it carries a default (D-4). Read it
  // through `EnvService` — a Zod default lands on the parsed object, never on
  // `process.env`.
  JWT_EXPIRES_IN: z.string().optional().default('7d'),
  NODE_ENV: z.string().optional().default('development'),
  // Fecha o cadastro de contas novas — as três portas de criação (senha,
  // Google, Facebook), não só a que a interface esconde.
  //
  // Existe porque a landing entrou em pré-lançamento e passou a mostrar uma
  // lista de espera no lugar do formulário. Esconder a tela não fecha nada: os
  // botões de Google e Facebook continuam na **tela de login**, e o primeiro
  // login por Facebook cria a conta na hora. Uma regra que só a interface
  // aplica não é regra.
  //
  // Mesma coerção 'true'/'false' dos demais interruptores: `z.coerce.boolean`
  // trata qualquer string não vazia — inclusive 'false' — como verdadeira, o
  // que aqui fecharia o cadastro justamente para quem tentou abri-lo. O enum
  // recusa qualquer outro valor no boot, e falhar o deploy é melhor do que
  // servir cadastros que alguém acredita estarem fechados.
  REGISTRATION_DISABLED: z
    .enum(['true', 'false'])
    .optional()
    .default('false')
    .transform((value) => value === 'true'),
  REDIS_URL: z.string(),
  // Comma-separated list of additional allowed CORS origins (beyond FRONTEND_URL).
  CORS_ALLOWED_ORIGINS: z.string().optional(),
  // Which upstream hops may describe the caller: a hop count ('1'), a
  // comma-separated list of proxy addresses/CIDRs, or an Express preset
  // ('loopback', 'uniquelocal'). Decides what `req.ip` resolves to, and therefore
  // what the per-IP throttle and the security audit trail believe.
  //
  // Optional, defaulting to one hop — correct behind exactly one load balancer and
  // the behaviour this app already had. Prefer the list form in production: a hop
  // count trusts whichever peer happens to connect, so a caller reaching the API
  // directly is trusted to state its own origin and can mint a fresh rate-limit
  // budget per request.
  TRUSTED_PROXIES: z.string().optional(),
  // Whether to mount /docs, /docs-json and /scalar. Left unset it follows the
  // environment: on outside production, off in production — the API surface,
  // request schemas and error codes are reconnaissance material, and they were
  // being served unauthenticated. Set explicitly to override either way.
  DOCS_ENABLED: z.enum(['true', 'false']).optional(),
  // Master switch for the progressive brute-force lockout engine. Coerced from
  // the literal strings 'true'/'false' (plain z.coerce.boolean treats any
  // non-empty string — including 'false' — as true).
  SECURITY_BRUTE_FORCE_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .default('true')
    .transform((value) => value === 'true'),
  // Resolve product entitlement by the account's organization subscription
  // (owner/active-member) in addition to the personal account subscription.
  // The merge is strictly additive — it can only grant access a personal
  // subscription would already grant — so it defaults on, but stays a kill
  // switch for instant rollback. Same 'true'/'false' coercion as above.
  ORG_SCOPED_ENTITLEMENT: z
    .enum(['true', 'false'])
    .optional()
    .default('true')
    .transform((value) => value === 'true'),
  // Kill switch for the creative video preview pipeline (ffmpeg first-frame
  // extraction + S3 upload). Turning it off stops previews from being enqueued
  // and makes any already-queued job a no-op, so a broken/unavailable ffmpeg
  // binary never fails campaign creation. Same 'true'/'false' coercion as above.
  VIDEO_PREVIEW_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .default('true')
    .transform((value) => value === 'true'),
  // Absolute path to an ffmpeg binary. Optional: defaults to the binary shipped
  // by the `ffmpeg-static` package, which is what production uses. Override it
  // when the bundled build cannot run on the host (e.g. musl-based images).
  FFMPEG_PATH: z.string().optional(),

  // ─── Câmbio (A2-S1, R-M / D19) ───────────────────────────────────────────
  //
  // Toda taxa é coletada CONTRA o pivô e qualquer par sai por taxa cruzada.
  // Coletar par a par explodiria em N² chamadas e faria BRL→EUR divergir de
  // EUR→BRL por arredondamento — o mesmo dinheiro com dois valores conforme a
  // direção da leitura.
  FX_PIVOT_CURRENCY: z.string().length(3).optional().default('USD'),
  // Nome do vendor, gravado na coluna `source` da tabela de câmbio e em cada
  // linha monetária (M2).
  FX_PROVIDER: z.string().optional().default('none'),
  // Sem base URL o provedor se declara não configurado: o job registra a
  // degradação e a ingestão segue com `normalizationPending`, em vez de tentar
  // e falhar a cada linha.
  FX_PROVIDER_BASE_URL: z.string().optional(),
  FX_PROVIDER_API_KEY: z.string().optional(),
  // 400 dias por decisão declarada (D19): cobre a retenção de 13 meses e a
  // linhagem que a atravessa. Backfill curto faz toda linha anterior a ele ficar
  // fora das agregações de inteligência (M1) — o mesmo que não ter o dado.
  FX_BACKFILL_DAYS: z.coerce.number().int().positive().optional().default(400),
  // Moedas extras a coletar além das observadas em contas e organizações.
  // Útil para pré-aquecer o histórico antes do primeiro onboarding.
  FX_TRACKED_CURRENCIES: z.string().optional(),

  // ─── Rollout ads-first (A2-S2, §14.7) ────────────────────────────────────
  //
  // Interruptor da superfície de leitura `/ads`, `/campaigns` e `/ad-sets`.
  // Nasce ligada em desenvolvimento e é o que permite desligar a tela principal
  // em produção sem deploy, caso o p95 de §17.2 não se sustente sob carga real.
  ADS_FIRST_READ_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .default('true')
    .transform((value) => value === 'true'),
  // Per-attempt ceiling for a single provider call. The orchestrator owns retry
  // and fallback, so a hung request must give up fast enough to leave budget for
  // the next candidate instead of holding the worker for the SDK default.
  AI_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .default(45_000),
  // A moeda em que `MODEL_PRICES_USD` é convertida, e a taxa da conversão.
  //
  // Os fornecedores publicam em dólar; o teto de gasto e o log de decisões vivem
  // na moeda-base da organização. O módulo `currency` não serve aqui: ele existe
  // para dinheiro de plataforma, onde a DATA do câmbio é a peça central (M2), e
  // custo de IA é fatura de fornecedor sem passado a reescrever. Amarrá-lo lá,
  // sem `fx_rates` populado, deixaria o custo permanentemente nulo e o teto
  // diário inerte.
  //
  // Em env porque taxa fixa em código envelhece e corrigi-la exigiria deploy.
  AI_PRICING_BASE_CURRENCY: z.string().length(3).optional().default('BRL'),
  AI_USD_TO_BASE_RATE: z.coerce.number().positive().optional().default(5.5),
  // How long a provider/model stays skipped after it reported being saturated,
  // rate limited or down. A provider that sends `Retry-After` overrides this.
  AI_PROVIDER_COOLDOWN_MS: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .default(30_000),
  // Optional (D-1): an AI provider key must not fail the boot. The orchestrator
  // already owns rate limiting, cooldown and fallback, and Sprint 5 removed exactly
  // this crash for `ANTHROPIC_API_KEY`. Absent, `OpenAIClient` refuses the request
  // with a clear error and `ConfigReadinessService` reports the degradation at boot.
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_CAMPAIGN_ANALYSIS_MODEL: z.string().optional(),
  OPENAI_FALLBACK_MODEL: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().optional(),
  ANTHROPIC_COPY_MODEL: z.string().optional(),
  ANTHROPIC_FALLBACK_MODEL: z.string().optional(),

  // ─── Storage de objetos ──────────────────────────────────────────────────
  //
  // Quem guarda upload de criativo, miniatura de vídeo e PDF de relatório. GCS
  // é o padrão; S3 continua inteiro e é escolhido trocando esta variável.
  //
  // O `preprocess` normaliza caixa e espaço porque isto é escolha de
  // infraestrutura escrita à mão num painel de deploy, e derrubar o boot por um
  // `gcs` minúsculo seria punir a digitação, não a configuração. Um valor que
  // **não** é nenhum dos dois continua falhando: cair no padrão em silêncio
  // mandaria os arquivos para uma nuvem que ninguém pediu.
  //
  // Nenhuma credencial de storage é crítica (P-6, camada opcional): faltando,
  // o provider recusa a chamada com `STORAGE_NOT_CONFIGURED` e o
  // `ConfigReadinessService` anuncia a degradação no boot.
  STORAGE_PROVIDER: z
    .preprocess(
      (value: unknown) =>
        typeof value === 'string' ? value.trim().toUpperCase() : value,
      z.enum(['GCS', 'S3']),
    )
    .optional()
    .default('GCS'),

  // Google Cloud Storage. Só o bucket é indispensável.
  //
  // As credenciais são opcionais **por decisão**: sem `GCS_KEY_FILENAME` e sem o
  // par `GCS_CLIENT_EMAIL`/`GCS_PRIVATE_KEY`, o SDK usa Application Default
  // Credentials — a service account anexada à instância no Cloud Run/GKE, que é
  // o modo recomendado pelo Google e o único que não coloca chave privada em
  // variável de ambiente. Chave explícita existe para rodar fora do Google.
  GCS_PROJECT_ID: z.string().optional(),
  GCS_BUCKET: z.string().optional(),
  GCS_CLIENT_EMAIL: z.string().optional(),
  // PEM multilinha numa variável de uma linha: o `\n` chega literal e o provider
  // o converte antes de assinar.
  GCS_PRIVATE_KEY: z.string().optional(),
  // Caminho para o JSON da service account. Alternativa ao par acima; quando os
  // dois estão presentes, o arquivo vence.
  GCS_KEY_FILENAME: z.string().optional(),
  // Domínio próprio/CDN na frente do bucket, usado só na URL de leitura. A URL
  // assinada de escrita continua apontando para o host que assinou.
  GCS_PUBLIC_BASE_URL: z.string().optional(),

  // Amazon S3, agora alternativo. Lido pelo `S3StorageProvider` via `EnvService`.
  AWS_REGION: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  AWS_S3_BUCKET: z.string().optional(),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_STARTER: z.string().optional(),
  STRIPE_PRICE_PRO: z.string().optional(),
  STRIPE_PRICE_ENTERPRISE: z.string().optional(),
  PORT: z.coerce.number().optional().default(8080),
  FRONTEND_URL: z.string(),
  // Onde ESTA API é alcançável de fora. Só existe por causa de um link que o
  // usuário clica de dentro do e-mail: o download de relatório passa por uma
  // rota daqui, que valida o token e redireciona para a URL assinada do bucket.
  //
  // Opcional, e a degradação é declarada: sem ela, o e-mail deixa de oferecer
  // download direto e passa a apontar para o relatório no app — que funciona,
  // porque lá existe sessão. Um default do tipo `http://localhost:PORT` seria
  // pior que a ausência, porque mandaria e-mail de produção com link para a
  // máquina de quem fez o deploy.
  API_PUBLIC_URL: z.string().optional(),
  EMAIL_PROVIDER: z
    .enum(['console', 'smtp', 'brevo'])
    .optional()
    .default('console'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  BREVO_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().email().optional(),
  EMAIL_FROM_NAME: z.string().optional(),
  // Destinatário exclusivo das mensagens de suporte enviadas pela plataforma —
  // nunca remetente. O remetente continua sendo `EMAIL_FROM`; ver
  // `SendSupportMessageUseCase`.
  ALLVA_SUPPORT_EMAIL: z.string().email().optional(),
  // Logo exibida no cabeçalho e no rodapé dos e-mails. Precisa ser uma URL
  // pública e permanente — o bucket de storage não serve, porque suas URLs de
  // leitura são assinadas e expiram em uma hora, quebrando a imagem em qualquer
  // e-mail relido depois disso. Opcional porque o padrão em `theme.ts` aponta
  // para o site institucional, que é o mesmo em todos os ambientes.
  EMAIL_LOGO_URL: z.string().url().optional(),
  // O wordmark "Allva" ao lado do ícone no cabeçalho — mesma regra da variável
  // acima (URL pública e permanente, padrão aponta para o site institucional).
  EMAIL_LOGO_MARCA_URL: z.string().url().optional(),
  // Provider credentials are optional, uniformly (D-2). Previously these four
  // failed the boot while `GOOGLE_ADS_*` / `TIKTOK_ADS_*` — same nature — did not.
  // Every consumer already declares itself unavailable when they are absent:
  // `GoogleIdTokenVerifier` → GOOGLE_SSO_NOT_CONFIGURED,
  // `FacebookAccessTokenVerifier` → FACEBOOK_SSO_NOT_CONFIGURED,
  // `MetaAdsProvider` → PROVIDER_NOT_CONFIGURED. The degradation is reported at
  // boot by `ConfigReadinessService`, so it is visible rather than silent.
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CALLBACK_URL: z.string().optional(),
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_CALLBACK_URL: z.string().optional(),
  // A versão da Graph API vive em configuração porque **ela expira sozinha**, e
  // a expiração não avisa: v19.0 ficou indisponível em 21/05/2026 com o número
  // fixo no código, e chamada a versão morta é roteada por decisão da Meta, não
  // pela nossa. Aqui, subir de versão é variável de ambiente com rollback
  // imediato — o que importa quando o mesmo provider passa a escrever (A2-S7) e
  // um comportamento novo precisa ser desfeito sem deploy.
  //
  // O `regex` recusa `19.0`, `v19` e `latest`: string errada aqui não falha no
  // boot, falha na primeira chamada à plataforma, como 404 sem explicação.
  META_API_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/, 'META_API_VERSION must look like "v25.0"')
    .optional()
    .default('v25.0'),
  INTEGRATION_TOKEN_ENCRYPTION_KEY: z
    .string()
    .min(32, 'INTEGRATION_TOKEN_ENCRYPTION_KEY must be at least 32 characters'),
  GOOGLE_ADS_CLIENT_ID: z.string().optional(),
  GOOGLE_ADS_CLIENT_SECRET: z.string().optional(),
  GOOGLE_ADS_DEVELOPER_TOKEN: z.string().optional(),
  GOOGLE_ADS_REDIRECT_URI: z.string().optional(),
  GOOGLE_ADS_SCOPES: z.string().optional(),
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: z.string().optional(),
  // Mesma razão de `META_API_VERSION`, e o mesmo defeito encontrado: o provider
  // estava fixo em `v17`, de meados de 2024, e o Google aposenta cada versão
  // ~13 meses depois de lançá-la. v25 saiu em 22/07/2026; `v24` (22/04/2026) é
  // a escolha N-1 — battle-tested, com ~9 meses de folga, e trocável por
  // variável quando o momento for de subir.
  GOOGLE_ADS_API_VERSION: z
    .string()
    .regex(/^v\d+$/, 'GOOGLE_ADS_API_VERSION must look like "v24"')
    .optional()
    .default('v24'),
  TIKTOK_ADS_CLIENT_ID: z.string().optional(),
  TIKTOK_ADS_CLIENT_SECRET: z.string().optional(),
  TIKTOK_ADS_REDIRECT_URI: z.string().optional(),
  TIKTOK_ADS_SCOPES: z.string().optional(),
  // Leitura das campanhas Smart+ do TikTok pelas rotas próprias (`/smart_plus/*`),
  // só onde as rotas padrão não as cobrem (D24). Nasce **desligada**: foi escrita a
  // partir da documentação oficial e ainda não foi conferida contra conta real —
  // ligar só depois de `pnpm verify:tiktok-smart-plus -- --compare`. Mesma
  // coerção 'true'/'false' dos demais interruptores.
  TIKTOK_SMART_PLUS_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .default('false')
    .transform((value) => value === 'true'),
  // ─── AI Score (A2-S4, §14.7) ─────────────────────────────────────────────
  //
  // Interruptor do ciclo diário de scoring. Desligado, o cron não enfileira e
  // nenhum score novo é gravado — a série existente continua legível, porque
  // apagar o que já foi apurado seria uma decisão diferente da de parar de
  // apurar.
  AD_SCORING_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .default('true')
    .transform((value) => value === 'true'),

  // ─── Waste Detector v2 (A2-S5, §14.7) ────────────────────────────────────
  //
  // Interruptor do ciclo diário de detecção. Desligado, o cron não enfileira e
  // nenhum achado novo é gravado — **e nenhum achado aberto é resolvido**, que é
  // a metade menos óbvia: desligar o detector não pode ser uma forma indireta de
  // declarar que o desperdício acabou.
  WASTE_DETECTOR_V2_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .default('true')
    .transform((value) => value === 'true'),

  // §8.9 — nasce ligada e existe para ser desligada em investigação, não para
  // adiar a proteção. Desligada, `ZERO_CONVERSIONS`, `LOW_ROAS` e `HIGH_CPA`
  // passam a disparar sobre janela ainda em re-declaração: é dado que **vai
  // mudar**, e a recomendação derivada é pausar um anúncio que converteu.
  DATA_MATURITY_GATING_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .default('true')
    .transform((value) => value === 'true'),

  // ─── Escrita em plataforma (A2-S7, RP5) ──────────────────────────────────
  //
  // **As duas nascem na posição segura, e não é simetria decorativa.**
  //
  // `PLATFORM_ACTIONS_ENABLED=false` desliga a superfície inteira: sem ela, uma
  // instalação que ainda não decidiu escrever não tem como escrever por
  // acidente. Ligá-la é a decisão de piloto → 10% → geral.
  //
  // `PLATFORM_ACTIONS_DRY_RUN_ONLY=true` é a segunda tranca, e vale mesmo com a
  // primeira aberta: a superfície responde, valida, revalida premissa e recusa
  // no último passo. É o que permite exercitar o caminho inteiro em produção —
  // com dados reais, usuários reais e concorrência real — sem mover dinheiro. O
  // plano exige **duas semanas** assim antes da primeira escrita real, e o
  // default é o que garante que esquecer de configurar erre para o lado seguro.
  PLATFORM_ACTIONS_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .default('false')
    .transform((value) => value === 'true'),
  PLATFORM_ACTIONS_DRY_RUN_ONLY: z
    .enum(['true', 'false'])
    .optional()
    .default('true')
    .transform((value) => value === 'true'),
  // C10 — a rajada por organização, em escritas por minuto.
  //
  // Não é `OrganizationAdsSettings` porque não é preferência do cliente: é
  // limitador de blast radius de R1, e o cliente que mais quer aumentá-lo é
  // justamente aquele cujo script em laço o está atingindo. O teto diário,
  // esse sim, é configurável por organização — ele responde "quanto",
  // enquanto este responde "a que velocidade".
  PLATFORM_ACTIONS_ORG_RATE_LIMIT_PER_MINUTE: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .default(30),

  // ─── Recommendation Engine (A2-S6) ───────────────────────────────────────
  //
  // Interruptor do ciclo diário de geração e da superfície `/recommendations`.
  // **Não é a flag de escrita** — essa é `PLATFORM_ACTIONS_ENABLED`, e nasce em
  // A2-S7 desligada. Esta governa o motor que propõe; nada aqui toca plataforma.
  RECOMMENDATION_ENGINE_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .default('true')
    .transform((value) => value === 'true'),

  // ─── Sync Engine v2 (A2-S3, §14.7) ───────────────────────────────────────
  //
  // Interruptor dos cinco fluxos. Desligado, o cron não enfileira nada e a
  // superfície `/sync` continua respondendo — é o que permite parar de consumir
  // cota de plataforma sem derrubar a leitura do que já foi ingerido.
  ADS_SYNC_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .default('true')
    .transform((value) => value === 'true'),
  ADS_SYNC_QUEUE_NAME: z.string().optional().default('allva-ads-sync'),
  ADS_SYNC_CRON: z.string().optional().default('0 3 * * *'),
  ADS_SYNC_LOOKBACK_DAYS: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .default(7),
  // Profundidade do **primeiro** ingest de uma conta de anúncios.
  //
  // A janela normal é a de re-declaração (7 dias). Ela serve ao regime
  // permanente, e servia mal ao primeiro dia: um dia só vira `MATURE` com 14
  // dias de idade, e os detectores que produzem número em dinheiro
  // (ZERO_CONVERSIONS, LOW_ROAS, HIGH_CPA) exigem `MATURE`. Com 7 dias, a
  // primeira afirmação confiável saía por volta do 12º dia — depois de metade
  // de um teste gratuito, e depois de duas semanas de silêncio para quem paga.
  //
  // Com 30, os dias D-29..D-14 já chegam maduros e o produto fala na primeira
  // madrugada.
  ADS_SYNC_BACKFILL_DAYS: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .default(30),
  // Teto absoluto de qualquer leitura para trás. Existe para que aumentar
  // `ADS_SYNC_BACKFILL_DAYS` num .env não vire, sem querer, uma varredura de um
  // ano contra o rate limit da plataforma no onboarding (R4).
  ADS_SYNC_MAX_LOOKBACK_DAYS: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .default(90),
  ADS_SYNC_COOLDOWN_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .default(60),
});

/**
 * The boot guard (Sprint 6 / Ops readiness, rule from P-6 / D-3).
 *
 * `EnvModule` runs this via `ConfigModule.validate`, so a production deploy
 * missing a conditionally-critical secret throws here and the process never binds
 * a port. That is the intended blast radius: it is strictly better to fail to
 * deploy than to serve a billing webhook that cannot verify signatures.
 *
 * Only *conditionally* critical rules belong here. Unconditionally critical
 * variables are already non-optional in the shape above, and optional ones must
 * never reach this function — they are logged by `ConfigReadinessService`.
 */
export const envSchema = envShape.superRefine((env, ctx) => {
  for (const blocker of findProductionBlockers(env)) {
    ctx.addIssue({
      code: 'custom',
      path: [blocker.key],
      message: blocker.message,
    });
  }
});

export type Env = z.infer<typeof envSchema>;
