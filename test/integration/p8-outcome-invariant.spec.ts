import type { Client } from 'pg';
import { databaseHarness } from '../support/database';

/**
 * **P8 contra o banco** — o gate de saída de A2-S9.
 *
 * > *"Toda `Recommendation` em `APPLIED` com janela pós completa tem outcome
 * > persistido."*
 *
 * A verificação estrutural vive em `test/architecture/measurement-cycle.spec.ts`
 * e prova que a cadeia existe no código. Esta prova que o **dado** obedece — que
 * é a metade que envelhece mal: o código pode continuar correto enquanto uma
 * migração, um script de correção ou uma escrita manual deixam uma aplicação sem
 * régua.
 *
 * O buraco que ela procura é **irrecuperável**. O "pré" é um fato do instante da
 * aplicação; reconstruí-lo depois lê dado que a plataforma já re-declarou (§8.9)
 * e contamina o dataset de acurácia com o próprio fenômeno que o produto mede em
 * toda parte. Não há correção — só a descoberta, o mais cedo possível.
 *
 * **Pula quando não há banco alcançável**, como `schema-gates-db.spec.ts`.
 */
const db = databaseHarness('p8-outcome-invariant');

beforeAll(async () => {
  await db.connect();
}, 20_000);

afterAll(async () => {
  await db.close();
});

const withDatabase = db.with;

describe('P8 — toda aplicada tem outcome persistido', () => {
  it('nenhuma recomendação APPLIED existe sem linha de outcome', async () => {
    await withDatabase(async (db) => {
      const { rows } = await db.query<{ id: string; applied_at: Date }>(
        `SELECT r."id", r."applied_at"
           FROM "recommendations" r
           LEFT JOIN "recommendation_outcomes" o
             ON o."recommendation_id" = r."id"
          WHERE r."status" = 'APPLIED'
            AND r."advisory" = false
            AND o."id" IS NULL`,
      );

      expect(rows).toEqual([]);
    });
  });

  /**
   * O outcome nasce **na transação** que grava `appliedAt` (§9.5 passo 6). Um
   * `applied_at` nulo numa `APPLIED`, ou um outcome cujo `applied_at` diverge do
   * da recomendação, significa que as duas escritas aconteceram separadas — e a
   * separação é exatamente o que ⊕9 tornou impossível ao deixar `post*` nullable.
   */
  it('o outcome carrega o mesmo appliedAt da recomendação', async () => {
    await withDatabase(async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `SELECT r."id"
           FROM "recommendations" r
           JOIN "recommendation_outcomes" o
             ON o."recommendation_id" = r."id"
          WHERE r."status" = 'APPLIED'
            AND (r."applied_at" IS NULL OR r."applied_at" <> o."applied_at")`,
      );

      expect(rows).toEqual([]);
    });
  });

  /**
   * ⊕9 — os campos do pós são nullable **por necessidade estrutural**, e os do
   * pré não. Uma linha sem pré é uma linha que nasceu sem régua: ela não pode
   * ser medida nunca, e ocupa o denominador de P8 para sempre.
   */
  it('nenhum outcome existe sem o snapshot pré', async () => {
    await withDatabase(async (db) => {
      const { rows } = await db.query<{ vazios: string }>(
        `SELECT count(*)::text AS vazios
           FROM "recommendation_outcomes"
          WHERE "pre_spend_base" IS NULL
             OR "fx_rate_fixed" IS NULL
             OR "lineage_id" IS NULL
             OR "observed_delta_kind" IS NULL`,
      );

      expect(rows[0]?.vazios).toBe('0');
    });
  });

  /**
   * Toda linha **medida** carrega a versão da medição. §20-H3 mede acurácia ao
   * longo de 90 dias; uma linha medida sem versão entra no denominador sem que
   * ninguém saiba por que régua — e o número que autoriza automação vira média
   * de medidas distintas.
   */
  it('toda medição concluída declara measurement_version e verdict', async () => {
    await withDatabase(async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `SELECT "id" FROM "recommendation_outcomes"
          WHERE "status" = 'MEASURED'
            AND ("measurement_version" IS NULL OR "verdict" IS NULL)`,
      );

      expect(rows).toEqual([]);
    });
  });

  /**
   * §16.16 — nenhum status não terminal sem caminho de saída. `APPLYING` é o
   * mais perigoso deles: a tela diz "aplicando…" e o usuário espera. As duas
   * saídas existem (a execução assenta, ou o reaper a recolhe), e uma linha
   * presa há horas significa que nenhuma das duas correu.
   */
  it('nenhuma recomendação fica em APPLYING por mais de uma hora', async () => {
    await withDatabase(async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `SELECT r."id"
           FROM "recommendations" r
          WHERE r."status" = 'APPLYING'
            AND r."evidence_as_of" < now() - interval '1 hour'`,
      );

      expect(rows).toEqual([]);
    });
  });
});
