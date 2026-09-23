// `DATABASE_URL` vive no `.env`, e o Jest não o carrega sozinho — sem esta
// linha o teste **pula em silêncio** na máquina de quem tem o banco de pé, que
// é exatamente onde ele deveria rodar. Em CI, sem `.env` e sem a variável
// exportada, o comportamento continua o mesmo: pular e dizer por quê.
import type { Client } from 'pg';
import { databaseHarness } from '../support/database';

/**
 * Os gates que só existem contra dados: partições, `CHECK`s e índices parciais
 * lidos do `information_schema` / catálogo do Postgres (§14.5).
 *
 * **Pula quando não há banco alcançável.** O CI roda sem Postgres — as suítes
 * são unitárias —, e um gate que falha por ausência de infraestrutura ensina o
 * time a ignorar vermelho. Rodando `docker compose up -d` e `pnpm test`, ele
 * verifica de verdade; é o mesmo comando que o passo de deploy executa depois de
 * `prisma migrate deploy`.
 */
const db = databaseHarness('schema-gates-db');

beforeAll(async () => {
  await db.connect();
}, 20_000);

afterAll(async () => {
  await db.close();
});

const withDatabase = db.with;

describe('gates de schema contra o banco (§14.5)', () => {
  it('G3 — os sete índices parciais existem no catálogo', async () => {
    await withDatabase(async (db) => {
      const { rows } = await db.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
          WHERE schemaname = 'public' AND indexname = ANY($1::text[])`,
        [
          [
            'waste_items_open_unique',
            'creative_analyses_version_unique',
            'recommendations_active_unique',
            'action_executions_inflight_unique',
            'alerts_open_unique',
            'sync_quarantine_open_unique',
            'currency_migrations_active_unique',
          ],
        ],
      );

      expect(rows.map((row) => row.indexname).sort()).toEqual([
        'action_executions_inflight_unique',
        'alerts_open_unique',
        'creative_analyses_version_unique',
        'currency_migrations_active_unique',
        'recommendations_active_unique',
        'sync_quarantine_open_unique',
        'waste_items_open_unique',
      ]);
    });
  });

  it('G12 — os quatro CHECK de coerência existem', async () => {
    await withDatabase(async (db) => {
      const { rows } = await db.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint
          WHERE contype = 'c' AND conname = ANY($1::text[]) ORDER BY conname`,
        [
          [
            'waste_items_status_coherent',
            'waste_items_resolution_coherent',
            'alerts_one_subject',
            'ai_decision_logs_one_subject',
          ],
        ],
      );

      expect(rows).toHaveLength(4);
    });
  });

  it('G4 — ad_metric_snapshots é particionada, com DEFAULT vazia', async () => {
    await withDatabase(async (db) => {
      const { rows: strategy } = await db.query<{ partstrat: string }>(
        `SELECT p.partstrat FROM pg_partitioned_table p
          WHERE p.partrelid = 'ad_metric_snapshots'::regclass`,
      );
      // 'r' = RANGE. Nascer particionada é gratuito; converter depois não é.
      expect(strategy[0]?.partstrat).toBe('r');

      const { rows: partitions } = await db.query<{ count: string }>(
        `SELECT count(*)::text FROM pg_inherits
          WHERE inhparent = 'ad_metric_snapshots'::regclass`,
      );
      expect(Number(partitions[0].count)).toBeGreaterThanOrEqual(4);

      // A DEFAULT é rede de segurança: linha nela é alerta operacional, não
      // caminho normal — significa que a manutenção de partições parou.
      const { rows: fallback } = await db.query<{ count: string }>(
        'SELECT count(*)::text FROM ad_metric_snapshots_default',
      );
      expect(Number(fallback[0].count)).toBe(0);
    });
  });

  it('a view open_waste é o caminho de agregação', async () => {
    await withDatabase(async (db) => {
      const { rows } = await db.query(
        `SELECT 1 FROM pg_views WHERE schemaname = 'public' AND viewname = 'open_waste'`,
      );
      expect(rows).toHaveLength(1);
    });
  });

  it('G13 — integrations.organization_id é NOT NULL', async () => {
    await withDatabase(async (db) => {
      const { rows } = await db.query<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_name = 'integrations' AND column_name = 'organization_id'`,
      );
      expect(rows[0]?.is_nullable).toBe('NO');
    });
  });

  it('G5 — o enum MetricLevel não existe mais no catálogo', async () => {
    await withDatabase(async (db) => {
      const { rows } = await db.query(
        `SELECT 1 FROM pg_type WHERE typname = 'MetricLevel'`,
      );
      expect(rows).toHaveLength(0);
    });
  });

  it('o CHECK de exclusividade de alerta recusa alerta órfão', async () => {
    await withDatabase(async (db) => {
      // O bug do v1 em uma linha: alerta sem sujeito. Aqui o banco recusa.
      await expect(
        db.query(
          `INSERT INTO alerts (id, organization_id, type, severity, title, message, fingerprint, updated_at)
           VALUES (gen_random_uuid(), gen_random_uuid(), 'SYSTEM', 'INFO', 't', 'm', 'fp-test', now())`,
        ),
      ).rejects.toThrow(/alerts_one_subject/);
    });
  });
});
