import { Client } from 'pg';
import { requireDatabaseWhenExpected } from '../support/database';

/**
 * **RLS contra o Postgres** — a mitigação de R9 que deixou de ser opcional.
 *
 * `docs/decisao-rls.md` concluiu por não ativar RLS na v2.0 e listou três
 * gatilhos de reabertura. O gatilho 2 — **exigência de conformidade** — passou a
 * valer, e a decisão inverteu.
 *
 * ## O que este arquivo prova, e por que ele é o único que pode
 *
 * A garantia de RLS **não é verificável pela aplicação**: ela roda como dono das
 * tabelas, que tem `BYPASSRLS` implícito e enxerga tudo por construção. Um teste
 * que passasse pela `PrismaService` normal reportaria isolamento sem ter
 * verificado nada.
 *
 * Por isso aqui há uma conexão própria, **como `app_rw`**, que é o papel sem
 * bypass. É a única forma de a asserção significar alguma coisa.
 *
 * ## O contrato em uma frase
 *
 * Sem `SET LOCAL app.organization_id`, a consulta devolve **zero linhas**.
 * Falha fechada: o pior desfecho é uma tela vazia, nunca dado do tenant errado.
 */

const SUFFIX = 'rls-spec';

/**
 * Os tenants são **organizações reais do banco**, não ids inventados.
 *
 * `waste_items.ad_id` tem FK para `ads`, que tem FK para conta, campanha e
 * integração — a cadeia inteira precisa existir. A primeira redação inventou
 * dois ids e a FK recusou, o que foi o schema fazendo o trabalho dele: um
 * achado de desperdício sem anúncio não deveria existir mesmo num teste.
 */
let tenantA = '';
let tenantB = '';

/** Sem `LOGIN`, o papel não conecta. O teste cria a senha e a revoga no fim. */
const RW_PASSWORD = 'rls-spec-password';

let owner: Client | null = null;
let restricted: Client | null = null;
let skipReason = '';

beforeAll(async () => {
  const probe = await requireDatabaseWhenExpected('rls-tenant-isolation');
  if (!probe.reachable) {
    skipReason = probe.reason;
    return;
  }

  owner = new Client({ connectionString: process.env.DATABASE_URL });
  await owner.connect();

  // `app_rw` nasce `NOLOGIN` de propósito: quem opera define a senha fora do
  // controle de versão. O teste a concede temporariamente para poder conectar.
  await owner.query(`ALTER ROLE app_rw LOGIN PASSWORD '${RW_PASSWORD}'`);

  const seeded = await seed(owner);
  if (!seeded) {
    skipReason = 'banco sem organização. Rode: pnpm seed:ads-v2';
    await owner.query('ALTER ROLE app_rw NOLOGIN').catch(() => undefined);
    await owner.end();
    owner = null;
    return;
  }

  const url = new URL(process.env.DATABASE_URL as string);
  url.username = 'app_rw';
  url.password = RW_PASSWORD;

  restricted = new Client({ connectionString: url.toString() });
  await restricted.connect();
}, 30_000);

afterAll(async () => {
  await restricted?.end().catch(() => undefined);

  if (owner) {
    await cleanup(owner).catch(() => undefined);
    await owner.query('ALTER ROLE app_rw NOLOGIN').catch(() => undefined);
    await owner.end().catch(() => undefined);
  }
});

async function withRestricted(
  assertion: (db: Client) => Promise<void>,
): Promise<void> {
  if (!restricted) {
    console.warn(`[rls-tenant-isolation] pulado — sem banco (${skipReason})`);
    return;
  }

  await assertion(restricted);
}

/**
 * Duas linhas de `waste_items` que diferem **só no `organization_id`**.
 *
 * É o que a política filtra, e é o que o teste precisa. A hierarquia acima
 * (conta, campanha, anúncio) existe porque `waste_items.ad_id` tem FK — mas
 * `organization_id` **não tem FK em `ads`, `campaigns` nem `waste_items`**, e é
 * por isso que o segundo tenant pode ser um id sintético sem organização real.
 *
 * Isso não é atalho de teste: é o formato do schema. A tenancy dessas tabelas é
 * uma **coluna denormalizada**, não uma relação — que é precisamente a razão de
 * RLS ser necessário aqui. Uma FK protegeria a integridade; ela não impede uma
 * consulta de ler a linha do vizinho.
 */
/**
 * Cria o inquilino, em vez de emprestar o primeiro do banco.
 *
 * A versão anterior fazia `SELECT ... LIMIT 1` e devolvia `false` quando não
 * achava — e no CI, que roda `migrate deploy` num banco vazio e nada mais, esse
 * era o único caminho. **Este é o teste de isolamento entre inquilinos**, e ele
 * passava verde sem executar uma consulta sequer.
 *
 * SQL cru como o resto do arquivo: aqui não há Prisma, e é de propósito — o
 * teste precisa falar com o banco pelo mesmo canal que a política de RLS
 * governa.
 */
async function seed(db: Client): Promise<boolean> {
  await cleanup(db);

  const owner = `${SUFFIX}-owner`;
  tenantA = `${SUFFIX}-org-a`;
  tenantB = `${SUFFIX}-org-b`;

  await db.query(
    `INSERT INTO "accounts" ("id", "name", "email", "password_hash")
     VALUES ($1, 'Titular RLS', $2, 'nao-usado-em-teste')
     ON CONFLICT ("id") DO NOTHING`,
    [owner, `${SUFFIX}@exemplo.test`],
  );

  // As duas organizações do teste: o isolamento é entre elas.
  for (const tenant of [tenantA, tenantB]) {
    await db.query(
      `INSERT INTO "organizations" ("id", "name", "owner_id")
       VALUES ($1, $2, $3)
       ON CONFLICT ("id") DO NOTHING`,
      [tenant, `Organização ${tenant}`, owner],
    );
  }

  const integrationId = `${SUFFIX}-integration`;
  await db.query(
    `INSERT INTO "integrations" ("id", "account_id", "organization_id", "provider",
       "provider_type", "access_token", "expires_at", "updated_at")
     VALUES ($1, $2, $3, 'meta', 'META', 'token-de-teste', '2099-01-01', NOW())
     ON CONFLICT ("id") DO NOTHING`,
    [integrationId, owner, tenantA],
  );

  const integration = { rows: [{ id: integrationId }] };

  await db.query(
    `INSERT INTO "ad_accounts" ("id", "account_id", "organization_id", "platform",
       "external_account_id", "name", "integration_id", "currency", "timezone")
     VALUES ($1, $2, $3, 'META', $4, 'Conta RLS', $5, 'BRL', 'America/Sao_Paulo')`,
    [`${SUFFIX}-acct`, owner, tenantA, `${SUFFIX}-ext`, integration.rows[0].id],
  );

  for (const [index, tenant] of [tenantA, tenantB].entries()) {
    await db.query(
      `INSERT INTO "campaigns" ("id", "ad_account_id", "organization_id", "platform",
         "integration_id", "external_campaign_id", "name", "currency")
       VALUES ($1, $2, $3, 'META', $4, $5, 'Campanha RLS', 'BRL')`,
      [
        `${SUFFIX}-camp-${index}`,
        `${SUFFIX}-acct`,
        tenant,
        integration.rows[0].id,
        `${SUFFIX}-camp-ext-${index}`,
      ],
    );

    await db.query(
      `INSERT INTO "ads" ("id", "account_id", "organization_id", "ad_account_id",
         "integration_id", "platform", "external_ad_id", "campaign_id",
         "lineage_id", "name", "observed_status", "sync_state", "updated_at")
       VALUES ($1, $2, $3, $4, $5, 'META', $6, $7, $1, 'Anúncio RLS', 'ACTIVE',
               'IN_SYNC', now())`,
      [
        `${SUFFIX}-ad-${index}`,
        owner,
        tenant,
        `${SUFFIX}-acct`,
        integration.rows[0].id,
        `${SUFFIX}-ad-ext-${index}`,
        `${SUFFIX}-camp-${index}`,
      ],
    );

    await db.query(
      `INSERT INTO "waste_items" (
         "id", "ad_id", "organization_id", "account_id", "finding_kind", "type",
         "priority", "window_days", "incurred_amount", "incurred_amount_base",
         "avoidable_daily_amount", "avoidable_daily_base", "currency",
         "base_currency", "diagnosis", "evidence", "evidence_sufficiency",
         "scope_level", "data_maturity", "detector_version",
         "detector_profile_version", "fingerprint", "status"
       ) VALUES (
         $1, $2, $3, $4, 'WASTE', 'ZERO_CONVERSIONS', 'HIGH', 14, 100, 100, 10,
         10, 'BRL', 'BRL', 'fixture', '{}'::jsonb, 'SUFFICIENT', 'AD', 'MATURE',
         'v1', 'v1', $5, 'OPEN'
       )`,
      [
        `${SUFFIX}-item-${index}`,
        `${SUFFIX}-ad-${index}`,
        tenant,
        owner,
        `${SUFFIX}-fp-${index}`,
      ],
    );
  }

  return true;
}

async function cleanup(db: Client): Promise<void> {
  await db.query(`DELETE FROM "waste_items" WHERE "id" LIKE '${SUFFIX}%'`);
  await db.query(`DELETE FROM "ads" WHERE "id" LIKE '${SUFFIX}%'`);
  await db.query(`DELETE FROM "campaigns" WHERE "id" LIKE '${SUFFIX}%'`);
  await db.query(`DELETE FROM "ad_accounts" WHERE "id" LIKE '${SUFFIX}%'`);
  // O inquilino sai por último: as tabelas acima o referenciam.
  await db.query(`DELETE FROM "integrations" WHERE "id" LIKE '${SUFFIX}%'`);
  await db.query(`DELETE FROM "organizations" WHERE "id" LIKE '${SUFFIX}%'`);
  await db.query(`DELETE FROM "accounts" WHERE "id" LIKE '${SUFFIX}%'`);
}

describe('R9 — isolamento no armazenamento, não só na aplicação', () => {
  /**
   * **O caso que justifica RLS existir.** Uma consulta que esqueceu o `WHERE
   * organization_id` é o modo de falha que a tenancy de aplicação não cobre —
   * e é exatamente esta consulta.
   */
  it('sem tenant declarado, uma consulta sem WHERE devolve zero linhas', async () => {
    await withRestricted(async (db) => {
      const { rows } = await db.query(
        `SELECT "id" FROM "waste_items" WHERE "id" LIKE '${SUFFIX}%'`,
      );

      expect(rows).toEqual([]);
    });
  });

  it('com o tenant declarado, devolve só as linhas dele', async () => {
    await withRestricted(async (db) => {
      await db.query('BEGIN');
      await db.query(`SET LOCAL app.organization_id = '${tenantA}'`);

      const { rows } = await db.query<{ id: string; organization_id: string }>(
        `SELECT "id", "organization_id" FROM "waste_items"
          WHERE "id" LIKE '${SUFFIX}%'`,
      );

      await db.query('COMMIT');

      expect(rows).toHaveLength(1);
      expect(rows[0].organization_id).toBe(tenantA);
    });
  });

  /**
   * `WITH CHECK`, e não só `USING`. Sem ele um tenant gravaria no espaço do
   * outro e perderia a linha de vista em seguida — pior que ler, porque é
   * silencioso: a escrita "funciona" e o dado some.
   */
  it('não consegue gravar linha de outro tenant', async () => {
    await withRestricted(async (db) => {
      await db.query('BEGIN');
      await db.query(`SET LOCAL app.organization_id = '${tenantA}'`);

      await expect(
        db.query(
          `INSERT INTO "waste_items" (
             "id", "ad_id", "organization_id", "account_id", "finding_kind",
             "type", "priority", "window_days", "incurred_amount",
             "incurred_amount_base", "avoidable_daily_amount",
             "avoidable_daily_base", "currency", "base_currency", "diagnosis",
             "evidence", "evidence_sufficiency", "scope_level",
             "data_maturity", "detector_version", "detector_profile_version",
             "fingerprint", "status"
           ) VALUES (
             '${SUFFIX}-intruso', '${tenantB}-ad', '${tenantB}',
             '${SUFFIX}-account', 'WASTE', 'LOW_ROAS', 'HIGH', 14, 1, 1, 1, 1,
             'BRL', 'BRL', 'intruso', '{}'::jsonb, 'SUFFICIENT', 'AD',
             'MATURE', 'v1', 'v1', '${SUFFIX}-intruso-fp', 'OPEN'
           )`,
        ),
      ).rejects.toThrow(/row-level security/i);

      await db.query('ROLLBACK');
    });
  });

  /**
   * O `UPDATE` que atravessa tenant não falha — ele **não encontra a linha**, e
   * a diferença importa: um erro seria informação sobre a existência do dado
   * alheio. Zero linhas afetadas não diz nada sobre o outro tenant.
   */
  it('um UPDATE cruzado não afeta nenhuma linha, e não vaza a existência dela', async () => {
    await withRestricted(async (db) => {
      await db.query('BEGIN');
      await db.query(`SET LOCAL app.organization_id = '${tenantA}'`);

      const result = await db.query(
        `UPDATE "waste_items" SET "priority" = 'LOW'
          WHERE "organization_id" = '${tenantB}'`,
      );

      await db.query('COMMIT');

      expect(result.rowCount).toBe(0);
    });
  });

  /** O dono das tabelas continua enxergando tudo — é ele que migra e opera. */
  it('o papel dono não é afetado pela política', async () => {
    if (!owner) return;

    const { rows } = await owner.query(
      `SELECT "id" FROM "waste_items" WHERE "id" LIKE '${SUFFIX}%'`,
    );

    expect(rows).toHaveLength(2);
  });
});
