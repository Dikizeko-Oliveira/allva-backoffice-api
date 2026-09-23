/**
 * O custo real de IA, medido contra `ai_decision_logs`.
 *
 *   pnpm ai:cost
 *   pnpm ai:cost -- --days=30
 *
 * ## Por que existe
 *
 * As decisões de packaging de IA foram tomadas com dois números medidos (o
 * perfil da narrativa, 382/186 tokens) e vários estimados a olho. A estimativa a
 * olho da geração de copy errou por mais de 2× — e errou para baixo, que é o
 * lado que faz um teto parecer folgado quando não é.
 *
 * Este relatório substitui a estimativa pelo que de fato aconteceu, e é a mesma
 * disciplina que `TYPICAL_NARRATIVE_TOKENS` já registra: *"este número se
 * corrige contra `AIDecisionLog`, que grava tokens de verdade, e não contra a
 * intuição de quem escreve o prompt."*
 *
 * ## O que ele confere que uma consulta solta não conferiria
 *
 * Recalcula o custo pela tabela de preços e compara com o que foi gravado. As
 * duas colunas divergindo significa uma de três coisas — preço do fornecedor
 * mudou, a taxa de câmbio mudou, ou o modelo saiu da tabela e está sendo cobrado
 * pelo mais caro —, e as três pedem providências diferentes. Um número sozinho
 * não distingue nenhuma delas.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { MODEL_PRICES_USD } from '../src/modules/ai/domain/model-pricing';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

/** A taxa do ambiente, que é como o custo gravado foi produzido. */
const USD_TO_BASE = Number(process.env.AI_USD_TO_BASE_RATE ?? 5.5);

/** As cotas publicadas, para a projeção mensal fazer sentido comercial. */
const QUOTAS: Record<string, Record<string, number>> = {
  creative_suggestion: { Individual: 20, Profissional: 100, Enterprise: 300 },
  creative_diagnosis: {
    Individual: 300,
    Profissional: 3_000,
    Enterprise: 10_000,
  },
};

/** O volume noturno, que não tem cota — escala com anúncios monitorados. */
const NIGHTLY: Record<string, Record<string, number>> = {
  AD_NARRATIVE: { Individual: 300, Profissional: 2_000, Enterprise: 5_000 },
};

type Row = {
  task_type: string;
  provider: string;
  model: string;
  n: bigint;
  p50_in: number | null;
  p50_out: number | null;
  p95_in: number | null;
  p95_out: number | null;
  avg_cost: string | null;
  sem_taxa: bigint;
};

function priced(model: string, input: number, output: number): number | null {
  const price = MODEL_PRICES_USD[model];
  if (!price) return null;

  const usd =
    (input * price.inputPerMillionUsd + output * price.outputPerMillionUsd) /
    1_000_000;

  return usd * USD_TO_BASE;
}

const brl = (value: number | null): string =>
  value === null ? '—' : `R$ ${value.toFixed(6)}`;

async function main(): Promise<void> {
  const days = Number(
    process.argv.find((arg) => arg.startsWith('--days='))?.split('=')[1] ?? 90,
  );

  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);

  const rows = await prisma.$queryRaw<Row[]>`
    SELECT
      "task_type", "provider", "model",
      COUNT(*) AS n,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY "input_tokens")  AS p50_in,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY "output_tokens") AS p50_out,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY "input_tokens")  AS p95_in,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY "output_tokens") AS p95_out,
      AVG("cost_base") AS avg_cost,
      COUNT(*) FILTER (WHERE "usd_to_base_rate" IS NULL) AS sem_taxa
    FROM "ai_decision_logs"
    WHERE "outcome" = 'SUCCEEDED'
      AND "created_at" >= ${since}
      -- Chamadas sem token medido não descrevem custo de nada: elas são o
      -- fallback em memória e um caminho antigo que não reportava uso.
      AND "input_tokens" > 0
    GROUP BY 1, 2, 3
    ORDER BY 1, n DESC
  `;

  if (rows.length === 0) {
    console.log(`Nenhuma chamada medida nos últimos ${days} dias.`);
    return;
  }

  console.log(
    `\nCusto de IA — últimos ${days} dias (taxa USD→base: ${USD_TO_BASE})\n`,
  );

  for (const row of rows) {
    const p50In = Math.round(row.p50_in ?? 0);
    const p50Out = Math.round(row.p50_out ?? 0);
    const medido = row.avg_cost === null ? null : Number(row.avg_cost);
    const esperado = priced(row.model, p50In, p50Out);

    console.log(
      `${row.task_type.padEnd(20)} ${row.model.padEnd(17)} ` +
        `n=${String(row.n).padStart(5)}  ` +
        `p50 ${String(p50In).padStart(5)}/${String(p50Out).padStart(5)} tok  ` +
        `p95 ${String(Math.round(row.p95_in ?? 0)).padStart(5)}/${String(
          Math.round(row.p95_out ?? 0),
        ).padStart(5)}  ` +
        `medido ${brl(medido)}  tabela ${brl(esperado)}`,
    );

    /**
     * Divergência acima de 5% é sinal, não ruído: o custo gravado e o preço de
     * tabela deveriam produzir o mesmo número sobre os mesmos tokens.
     */
    if (medido !== null && esperado !== null && esperado > 0) {
      const desvio = Math.abs(medido - esperado) / esperado;
      if (desvio > 0.05) {
        console.log(
          `${' '.repeat(20)} ⚠ divergência de ${(desvio * 100).toFixed(0)}% ` +
            'entre o custo gravado e a tabela de preços — preço do fornecedor, ' +
            'taxa de câmbio ou modelo fora da tabela',
        );
      }
    }

    if (Number(row.sem_taxa) > 0) {
      console.log(
        `${' '.repeat(20)} ${row.sem_taxa} de ${row.n} sem a taxa carimbada ` +
          '(linhas anteriores à coluna `usd_to_base_rate`)',
      );
    }
  }

  console.log('\nProjeção mensal por organização, ao teto de cada plano:\n');

  for (const row of rows) {
    const medido = row.avg_cost === null ? null : Number(row.avg_cost);
    if (medido === null) continue;

    const volumes = QUOTAS[row.task_type] ?? NIGHTLY[row.task_type];
    if (!volumes) continue;

    const sufixo = QUOTAS[row.task_type] ? 'cota' : 'por noite × 30';
    const projecao = Object.entries(volumes)
      .map(([plano, volume]) => {
        const mensal = NIGHTLY[row.task_type] ? volume * 30 : volume;
        return `${plano} R$ ${(medido * mensal).toFixed(2)}`;
      })
      .join('  ·  ');

    console.log(
      `${row.task_type.padEnd(20)} ${row.model.padEnd(17)} (${sufixo})  ${projecao}`,
    );
  }

  console.log('');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
