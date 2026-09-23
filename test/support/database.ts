import 'dotenv/config';
import { Client } from 'pg';

/**
 * A conexão dos testes que tocam banco — **num lugar só**.
 *
 * O padrão nasceu duplicado em cinco arquivos (`schema-gates-db`,
 * `job-runs-takeover`, `organization-ads-settings`, `waste-rollup`,
 * `recommendations-active-unique`) e ganhou o sexto em A2-S9. Seis cópias da
 * mesma decisão é como uma delas passa a divergir sem que ninguém note — e a que
 * diverge é sempre a que pula quando deveria falhar.
 *
 * **O `dotenv/config` no topo não é conveniência.** O Jest não carrega `.env`
 * sozinho: sem ele, `DATABASE_URL` chega vazia na máquina de quem tem o banco de
 * pé e a suíte inteira passa sem asserção nenhuma. Foi um dos três defeitos que
 * A2-S3 encontrou.
 */

const CONNECT_TIMEOUT_MS = 2_000;

/**
 * **Quando pular deixa de ser aceitável.**
 *
 * Na máquina de quem não subiu o `docker-compose`, pular é o comportamento
 * certo: o teste não é sobre a máquina dele. No CI, pular é o defeito — foi
 * exatamente assim que seis specs ficaram verdes por ausência durante quatro
 * sprints. `REQUIRE_DATABASE=true` inverte a escolha, e o job de integração o
 * define.
 */
function databaseRequired(): boolean {
  return process.env.REQUIRE_DATABASE === 'true' || process.env.CI === 'true';
}

export type DatabaseHarness = {
  /** `null` quando não há banco alcançável **e** ele não é obrigatório. */
  client(): Client | null;
  /** Executa a asserção com o banco, ou pula/falha conforme o ambiente. */
  with(assertion: (db: Client) => Promise<void>): Promise<void>;
  connect(): Promise<void>;
  close(): Promise<void>;
};

export function databaseHarness(label: string): DatabaseHarness {
  let client: Client | null = null;
  let reason = '';

  return {
    client: () => client,

    async connect() {
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) {
        reason = 'DATABASE_URL ausente';
        if (databaseRequired()) {
          throw new Error(
            `[${label}] DATABASE_URL ausente com REQUIRE_DATABASE — o job de integração precisa de banco`,
          );
        }
        return;
      }

      const candidate = new Client({
        connectionString,
        connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      });

      try {
        await candidate.connect();
        client = candidate;
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
        await candidate.end().catch(() => undefined);

        if (databaseRequired()) {
          throw new Error(`[${label}] banco inalcançável: ${reason}`);
        }
      }
    },

    async close() {
      await client?.end().catch(() => undefined);
    },

    async with(assertion) {
      if (!client) {
        // Só chega aqui quando o banco é opcional: `connect` já teria lançado.
        console.warn(`[${label}] pulado — sem banco alcançável (${reason})`);
        return;
      }

      await assertion(client);
    },
  };
}

/**
 * A sonda, para quem monta o próprio cliente (Prisma, por exemplo).
 *
 * `job-runs-takeover` precisa de `PrismaService`, não de um `pg.Client` cru — e
 * é a única que precisa. Expor a sonda separada evita que ela reimplemente a
 * decisão de pular-ou-falhar, que é a única parte que **não** pode divergir
 * entre os arquivos.
 */
export async function requireDatabaseWhenExpected(
  label: string,
): Promise<{ reachable: boolean; reason: string }> {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    if (databaseRequired()) {
      throw new Error(
        `[${label}] DATABASE_URL ausente com REQUIRE_DATABASE — o job de integração precisa de banco`,
      );
    }
    return { reachable: false, reason: 'DATABASE_URL ausente' };
  }

  const probe = new Client({
    connectionString,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });

  try {
    await probe.connect();
    await probe.end();
    return { reachable: true, reason: '' };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await probe.end().catch(() => undefined);

    if (databaseRequired()) {
      throw new Error(`[${label}] banco inalcançável: ${reason}`);
    }

    return { reachable: false, reason };
  }
}
