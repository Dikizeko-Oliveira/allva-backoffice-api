import { databaseHarness } from '../support/database';

/**
 * **Toda organização nasce inteira**: com `organization_ads_settings` (D16/A10),
 * com participação OWNER ativa e com a assinatura que declara o seu plano.
 *
 * A invariante existe desde A2-S1 e **nenhum processo a mantinha**: a tabela foi
 * criada, e só o seed de desenvolvimento produzia linha. Uma organização
 * provisionada por lead `CLOSED_WON` — o caminho real de entrada de cliente —
 * nascia sem configuração, e A2-S4 em diante leria dela a versão ativa de algo­
 * ritmo, a janela de scoring e os tetos de custo.
 *
 * Este é o mesmo padrão de verificação dos gates de §14.5: princípio normativo
 * sem verificador automatizado degrada em ~3 sprints (achado D8). Os dois
 * caminhos de criação foram corrigidos, mas o terceiro é questão de tempo — e
 * quem o escrever descobre aqui, não em produção.
 *
 * **Pula quando não há banco alcançável**, como `schema-gates-db.spec.ts`.
 */
const db = databaseHarness('organization-ads-settings');

beforeAll(async () => {
  await db.connect();
}, 20_000);

afterAll(async () => {
  await db.close();
});

const withDatabase = db.with;

describe('configuração de ads por organização (D16/A10)', () => {
  it('nenhuma organização existe sem a sua linha de configuração', async () => {
    await withDatabase(async (db) => {
      const { rows } = await db.query<{ id: string; name: string }>(
        `SELECT o."id", o."name"
           FROM "organizations" o
           LEFT JOIN "organization_ads_settings" s
             ON s."organization_id" = o."id"
          WHERE s."organization_id" IS NULL`,
      );

      expect(rows).toEqual([]);
    });
  });

  it('a configuração carrega os padrões declarados na tabela, não nulos', async () => {
    await withDatabase(async (db) => {
      // D16 recusou "versão ativa vira constante de código". O valor tem de vir
      // do banco preenchido — uma coluna nula devolveria a decisão ao código.
      const { rows } = await db.query<{ vazias: string }>(
        `SELECT count(*)::text AS vazias
           FROM "organization_ads_settings"
          WHERE "active_algo_version" IS NULL
             OR "active_detector_profile_version" IS NULL
             OR "scoring_window_days" IS NULL`,
      );

      expect(rows[0]?.vazias).toBe('0');
    });
  });

  /**
   * A segunda perna, que faltava.
   *
   * `owner_id` nomeia o criador; quem o RBAC lê é a participação
   * (`OrganizationAccessGuard`, `PermissionResolverService`, contagem de
   * assentos). Uma organização sem participação OWNER ativa tem dono no papel e
   * ninguém com permissão na prática — é o `membershipId: null` que
   * `CurrentOrganizationResolver` documenta ter encontrado em dado legado.
   *
   * **Verificar o resultado, e não o escritor, é o ponto.** São três os caminhos
   * que criam organização — `POST /organizations`, provisionamento de lead e o
   * do cadastro — e só dois passam por `saveWithOwner`: o de lead grava inline
   * porque a transação dele abrange conta, assinatura e o próprio lead, e um
   * método de repositório não entra nela sem que o port aprenda Prisma. Uma
   * consulta ao banco não se importa com quantos escritores existem: ela pega os
   * três, e o quarto.
   */
  it('nenhuma organização existe sem participação OWNER ativa', async () => {
    await withDatabase(async (db) => {
      const { rows } = await db.query<{ id: string; name: string }>(
        `SELECT o."id", o."name"
           FROM "organizations" o
          WHERE o."deleted_at" IS NULL
            AND NOT EXISTS (
              SELECT 1
                FROM "organization_users" u
               WHERE u."organization_id" = o."id"
                 AND u."role" = 'OWNER'
                 AND u."status" = 'ACTIVE'
                 AND u."deleted_at" IS NULL
            )`,
      );

      expect(rows).toEqual([]);
    });
  });

  /**
   * A terceira perna, e a que custou mais caro.
   *
   * `organization_subscriptions` é a **única** fonte de
   * `OrganizationPlanPortInterface.findPlanTypeByOrganizationId`, e essa porta é
   * a fonte de toda guarda de plano: as dezesseis chaves de
   * `ENFORCED_FEATURE_KEYS`, o teto de assentos, a régua da análise noturna, o
   * piso de histórico. `planAllows` fecha na dúvida — e a decisão está certa,
   * porque do outro lado há escrita em mídia paga.
   *
   * O que estava errado era a premissa de que a dúvida não aconteceria. Só o
   * provisionamento de lead `CLOSED_WON` gravava a linha; cadastro,
   * `POST /organizations` e o backfill não. O resultado foi o produto recusando
   * `PLAN_FEATURE_NOT_INCLUDED` — "o plano atual não inclui plataformas" — a um
   * cliente que estava vinculando a primeira conta de anúncios da Meta, com o
   * "atual" sendo literalmente o fallback de `planLabel(null)`.
   *
   * Verifica o resultado, e não o escritor, pela mesma razão das duas de cima:
   * uma consulta ao banco pega os três caminhos de criação, e o quarto.
   */
  it('nenhuma organização existe sem assinatura que declare o plano', async () => {
    await withDatabase(async (db) => {
      const { rows } = await db.query<{ id: string; name: string }>(
        `SELECT o."id", o."name"
           FROM "organizations" o
           LEFT JOIN "organization_subscriptions" s
             ON s."organization_id" = o."id"
          WHERE o."deleted_at" IS NULL
            AND s."organization_id" IS NULL`,
      );

      expect(rows).toEqual([]);
    });
  });

  /**
   * E a assinatura precisa apontar para um plano que existe.
   *
   * A FK garante a integridade referencial; o que ela não garante é que
   * `plan_id` resolva para um `type` que o catálogo conheça — e `planAllows`
   * trata "tipo desconhecido" exatamente como "sem plano": nega tudo.
   */
  it('toda assinatura de organização aponta para um plano do catálogo', async () => {
    await withDatabase(async (db) => {
      const { rows } = await db.query<{ organization_id: string }>(
        `SELECT s."organization_id"
           FROM "organization_subscriptions" s
           LEFT JOIN "plans" p ON p."id" = s."plan_id"
          WHERE p."id" IS NULL
             OR p."type" NOT IN ('FREE', 'STARTER', 'PRO', 'ENTERPRISE')`,
      );

      expect(rows).toEqual([]);
    });
  });
});
