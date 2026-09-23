import { ScoreEnrichmentService } from './score-enrichment.service';
import {
  estimateCostBase,
  evaluateBudget,
} from 'src/modules/ai/domain/ai-budget';
import type { AdNarrativeRequest } from '../../domain/ports/ad-narrative.generator';

/**
 * **P4 e C9 — os dois gates de IA do sprint.**
 *
 * P4: *determinístico primeiro, IA por cima.* Falha de provider, teto estourado
 * ou chave ausente produzem `narrative: null` e **nada mais muda**. O score já
 * foi calculado e persistido antes de qualquer coisa aqui acontecer.
 *
 * C9: chamada não feita por decisão é **informação de produto**. Sem o registro,
 * "a narrativa sumiu" tem duas explicações — economia e falha — e nenhuma forma
 * de distinguir uma da outra.
 */

const REQUEST: AdNarrativeRequest = {
  adName: 'Anúncio X',
  platform: 'META',
  aiScore: 62,
  aiConfidence: 0.4,
  coverageRatio: 1,
  components: [
    { name: 'audienceFit', value: 70, available: true, reasons: [] },
  ],
  unavailableReasons: { attention: 'Sem vídeo neste anúncio.' },
  windowDays: 14,
};

function build(
  options: {
    generate?: () => Promise<unknown>;
    limitBase?: number | null;
    spentBase?: number;
    planAllowsAi?: boolean;
  } = {},
) {
  const recorded: Array<Record<string, unknown>> = [];

  const generator = {
    generate:
      options.generate ??
      (() =>
        Promise.resolve({
          narrative: 'O anúncio converte bem para o público atual.',
          provider: 'openai',
          model: 'gpt-5.6-luna',
          inputTokens: 100,
          outputTokens: 50,
          fallbackUsed: false,
        })),
  };

  const decisions = {
    record: (entry: Record<string, unknown>) => {
      recorded.push(entry);
      return Promise.resolve();
    },
    spentTodayBase: () => Promise.resolve(options.spentBase ?? 0),
  };

  /**
   * O teto passou a vir de `AiBudgetReader`, do módulo `ai` — a contabilidade de
   * custo de LLM é da plataforma, não de `ad-scoring`, que era só o primeiro
   * consumidor. A análise criativa virou o segundo em A2-S9.
   */
  const budgets = {
    budgetFor: () =>
      Promise.resolve({
        llmDailyBudgetBase:
          options.limitBase === undefined ? null : options.limitBase,
        estimatedCallCostBase: 0.02,
        // O contexto viaja com o orçamento: o custo em moeda-base depende
        // da moeda-base da organização, não do processo.
        pricing: {
          baseCurrency: 'BRL',
          pricingBaseCurrency: 'BRL',
          usdToBase: 5.5,
        },
      }),
  };

  const planEntitlement = {
    allows: jest.fn().mockResolvedValue(options.planAllowsAi ?? true),
  };

  const service = new ScoreEnrichmentService(
    generator as never,
    decisions as never,
    budgets as never,
    planEntitlement as never,
  );

  jest
    .spyOn(
      (service as never as { logger: { warn: jest.Mock; error: jest.Mock } })
        .logger,
      'warn',
    )
    .mockImplementation(() => undefined);

  return { service, recorded };
}

const INPUT = {
  organizationId: 'org-1',
  adId: 'ad-1',
  request: REQUEST,
  inputDigest: 'digest-1',
  correlationId: 'corr-1',
};

describe('enriquecimento por IA (§12.6)', () => {
  it('devolve a narrativa e registra a chamada', async () => {
    const h = build();

    const result = await h.service.enrich(INPUT);

    expect(result.outcome).toBe('SUCCEEDED');
    expect(result.narrative).toContain('converte bem');
    expect(h.recorded[0]).toMatchObject({
      taskType: 'AD_NARRATIVE',
      outcome: 'SUCCEEDED',
      inputDigest: 'digest-1',
    });
  });

  it('**P4: provider fora do ar ⇒ campo nulo, e nada mais** — nunca relança', async () => {
    const h = build({
      generate: () => Promise.reject(new Error('todos os providers falharam')),
    });

    const result = await h.service.enrich(INPUT);

    expect(result.narrative).toBeNull();
    expect(result.outcome).toBe('FAILED');
    // A falha é registrada: sem isso, "sem narrativa" seria indistinguível de
    // "nunca foi pedida".
    expect(h.recorded[0]).toMatchObject({ outcome: 'FAILED' });
  });

  it('**C9: teto estourado pula a chamada e registra SKIPPED_BUDGET**', async () => {
    const chamou = jest.fn();
    const h = build({
      limitBase: 1,
      spentBase: 0.99,
      generate: () => {
        chamou();
        return Promise.resolve({} as never);
      },
    });

    const result = await h.service.enrich(INPUT);

    expect(chamou).not.toHaveBeenCalled();
    expect(result.outcome).toBe('SKIPPED_BUDGET');
    expect(result.narrative).toBeNull();
    expect(h.recorded[0]).toMatchObject({ outcome: 'SKIPPED_BUDGET' });
  });

  it('sem teto declarado, a chamada acontece', async () => {
    // `null` é "esta organização não declarou limite". Inventar um número seria
    // decidir por ela, e o valor errado cortaria o produto de quem paga por ele.
    const h = build({ limitBase: null, spentBase: 999 });

    expect((await h.service.enrich(INPUT)).outcome).toBe('SUCCEEDED');
  });

  it('falha do registro não derruba a narrativa já gerada e paga', async () => {
    const h = build();
    const service = h.service as never as {
      decisions: { record: () => Promise<void> };
    };
    service.decisions.record = () => Promise.reject(new Error('banco fora'));
    jest
      .spyOn(
        (h.service as never as { logger: { error: jest.Mock } }).logger,
        'error',
      )
      .mockImplementation(() => undefined);

    await expect(h.service.enrich(INPUT)).resolves.toMatchObject({
      outcome: 'SUCCEEDED',
    });
  });
});

describe('teto de custo (C9)', () => {
  it('conta o custo estimado ANTES da chamada', () => {
    // Somar só depois deixaria a última chamada sempre passar — e num lote de
    // mil anúncios isso é mil estouros de uma chamada cada.
    expect(
      evaluateBudget({
        spentBase: 0.99,
        limitBase: 1,
        estimatedCostBase: 0.02,
      }),
    ).toMatchObject({ allowed: false, reason: 'BUDGET_EXCEEDED' });
  });

  it('permite enquanto couber, e informa quanto sobra', () => {
    expect(
      evaluateBudget({ spentBase: 0.5, limitBase: 1, estimatedCostBase: 0.02 }),
    ).toMatchObject({ allowed: true });
  });

  it('sem teto, sempre permite', () => {
    expect(
      evaluateBudget({
        spentBase: 10_000,
        limitBase: null,
        estimatedCostBase: 5,
      }),
    ).toEqual({ allowed: true, remainingBase: null });
  });

  it('estima o custo por milhão de tokens', () => {
    expect(
      estimateCostBase({
        inputTokens: 1_000_000,
        outputTokens: 0,
        inputCostPerMillionBase: 3,
        outputCostPerMillionBase: 15,
      }),
    ).toBe(3);
  });
});
