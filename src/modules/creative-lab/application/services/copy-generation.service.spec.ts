import { CopyGenerationService } from './copy-generation.service';
import { COPY_GENERATION_CONTEXT_SCHEMA_VERSION } from 'src/modules/creative-lab/domain/schemas/copy-generation.schema';
import type { CopyGenerationContext } from 'src/modules/creative-lab/domain/schemas/copy-generation.schema';
import type { StoredGeneration } from 'src/modules/creative-lab/domain/ports/copy-generations.repository';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';

/**
 * As três guardas, e a razão de cada uma ter código próprio.
 *
 * "Seu plano não inclui" (comercial), "você usou as 20 do mês" (esperar ou subir
 * de plano) e "o teto diário de IA estourou" (voltar amanhã) são três problemas
 * com três soluções diferentes. Fundi-los num "não pode" é o defeito que estas
 * asserções existem para impedir.
 *
 * E a quarta propriedade, que é a promessa da feature: **provider fora do ar não
 * é erro** — é uma geração `AI_UNAVAILABLE` com o contexto e a sugestão
 * preservados.
 */

const context: CopyGenerationContext = {
  schemaVersion: COPY_GENERATION_CONTEXT_SCHEMA_VERSION,
  ad: {
    id: 'ad-1',
    name: 'Topo de funil — vídeo 15s',
    platform: 'META',
    campaignObjective: 'OUTCOME_LEADS',
    optimizationGoal: 'OFFSITE_CONVERSIONS',
  },
  currentCopy: {
    headline: 'Economize tempo na gestão da sua empresa',
    body: 'Nossa plataforma ajuda sua empresa a trabalhar melhor.',
    callToAction: 'LEARN_MORE',
    landingPageUrl: 'https://exemplo.com',
  },
  score: {
    adScoreId: 'score-1',
    aiScore: 38,
    aiConfidence: 0.7,
    components: {
      attention: { normalizedValue: 22, confidence: 0.8, available: true },
    },
  },
  analysis: { id: 'analysis-1', version: 3, verdict: 'CREATIVE_UNDERPERFORMS' },
  suggestions: [
    {
      type: 'WEAK_HOOK',
      target: 'HOOK',
      priority: 'HIGH',
      reason: 'A retenção nos primeiros segundos está em 22/100.',
      recommendation: 'Leve o benefício principal para a primeira linha.',
      confidence: 0.8,
      sourceComponent: 'attention',
    },
  ],
  inputs: {
    objective: 'LEADS',
    tone: 'DIRECT',
    focus: 'BENEFIT',
    extraInstructions: null,
  },
};

function storedGeneration(
  overrides: Partial<StoredGeneration> = {},
): StoredGeneration {
  return {
    id: 'generation-1',
    adId: 'ad-1',
    source: 'FROM_INSIGHT',
    status: 'COMPLETED',
    context,
    inputDigest: 'digest',
    engineVersion: 'copy-v1.0.0',
    promptVersion: 'copy-generation-v1',
    aiProvider: 'anthropic',
    aiModel: 'claude-copy',
    failureReason: null,
    createdAt: new Date('2026-09-04T12:00:00.000Z'),
    variants: [],
    ...overrides,
  };
}

function build(options: {
  used?: number;
  limit?: number | null;
  quotaAllowed?: boolean;
  spentBase?: number;
  limitBase?: number | null;
  generatorThrows?: boolean;
  existing?: StoredGeneration | null;
}) {
  const generator = {
    generate: jest.fn(async () => {
      if (options.generatorThrows) throw new Error('All AI providers failed');

      return {
        variants: [
          {
            angle: 'BENEFIT' as const,
            hook: 'Pare de perder horas.',
            primaryText: 'Pare de perder horas analisando campanhas.',
            headline: null,
            description: null,
            callToAction: 'SIGN_UP',
            reasoning: [
              {
                claim: 'Hook mais específico',
                addressesSuggestion: 'WEAK_HOOK',
              },
            ],
          },
        ],
        provider: 'anthropic',
        model: 'claude-copy',
        inputTokens: 900,
        outputTokens: 700,
        fallbackUsed: false,
      };
    }),
  };

  const persisted: unknown[] = [];

  const generations = {
    findByDigest: jest.fn(async () => options.existing ?? null),
    persist: jest.fn(async (input: { status: string }) => {
      persisted.push(input);
      return storedGeneration({
        status: input.status,
        variants: [],
      });
    }),
  };

  const decisions = {
    record: jest.fn(async () => undefined),
    spentTodayBase: jest.fn(async () => options.spentBase ?? 0),
  };

  const budgets = {
    budgetFor: jest.fn(async () => ({
      llmDailyBudgetBase: options.limitBase ?? null,
      estimatedCallCostBase: 0.05,
      pricing: {
        baseCurrency: 'BRL',
        pricingBaseCurrency: 'BRL',
        usdToBase: 5.4,
      },
    })),
  };

  /**
   * A cota deixou de ser `COUNT` + `INSERT` e virou reserva atômica: uma
   * instrução decide e consome. O dublê reflete isso — `reserveQuota` devolve o
   * **novo** total, ou a recusa já montada.
   */
  const planEntitlement = {
    reserveQuota: jest.fn(async () =>
      options.quotaAllowed === false
        ? {
            allowed: false as const,
            planLabel: 'Individual',
            featureLabel: 'Geração de copy',
            upgradeTo: 'Profissional',
            quota: { limit: options.limit ?? 20, used: options.limit ?? 20 },
            used: options.limit ?? 20,
            limit: options.limit ?? 20,
          }
        : {
            allowed: true as const,
            used: (options.used ?? 0) + 1,
            limit: options.limit ?? 20,
          },
    ),
    releaseQuota: jest.fn(async () => undefined),
    consumedIn: jest.fn(async () => options.used ?? 0),
    quotaFor: jest.fn(async () => options.limit ?? 20),
  };

  return {
    service: new CopyGenerationService(
      generator as never,
      generations as never,
      decisions as never,
      budgets as never,
      planEntitlement as never,
    ),
    generator,
    generations,
    decisions,
    planEntitlement,
    persisted,
  };
}

const input = {
  organizationId: 'org-1',
  accountId: 'acc-1',
  adId: 'ad-1',
  creativeId: 'creative-1',
  analysisId: 'analysis-1',
  adScoreId: 'score-1',
  source: 'FROM_INSIGHT' as const,
  context,
  fieldBudgets: [],
  regenerate: false,
  correlationId: null,
};

describe('geração de copy — a cota mensal', () => {
  it('deixa passar dentro do teto e devolve o consumo na resposta', async () => {
    const { service } = build({ used: 7, limit: 20 });

    const outcome = await service.generate(input);

    // A cota vem na resposta, e não só na recusa: descobrir o teto ao bater
    // nele é o pior momento possível.
    //
    // **8, e não 7**: com a reserva, o número devolvido já inclui a geração que
    // acabou de sair. Antes vinha a contagem de *antes* da chamada, e a tela
    // ficava uma unidade atrás do que a próxima recusa usaria.
    expect(outcome.quota).toEqual({ limit: 20, used: 8 });
  });

  it('recusa com PLAN_LIMITED e diz quando a cota volta', async () => {
    const { service, generator } = build({ quotaAllowed: false, used: 20 });

    await expect(service.generate(input)).rejects.toMatchObject({
      code: 'COPY_GENERATION_QUOTA_EXCEEDED',
    });

    // `PLAN_LIMITED` e não `NOT_PERMITTED`: o pedido é legítimo e a pessoa tem
    // a capacidade — o que acabou foi o volume.
    await expect(service.generate(input)).rejects.toBeInstanceOf(DomainError);
    expect(generator.generate).not.toHaveBeenCalled();
  });

  it('a recusa por cota aponta o plano que resolve', async () => {
    const { service } = build({ quotaAllowed: false, used: 20, limit: 20 });

    await expect(service.generate(input)).rejects.toMatchObject({
      details: expect.objectContaining({ upgradeTo: 'Profissional' }),
    });
  });
});

describe('geração de copy — o teto diário de gasto', () => {
  it('é uma recusa diferente da cota, e retentável', async () => {
    const { service, generator, decisions } = build({
      spentBase: 100,
      limitBase: 10,
    });

    await expect(service.generate(input)).rejects.toMatchObject({
      code: 'AI_DAILY_BUDGET_EXHAUSTED',
    });

    expect(generator.generate).not.toHaveBeenCalled();
    // C9: o corte é registrado. Em silêncio, "sumiu a geração" e "o provider
    // caiu" ficam indistinguíveis para quem investiga.
    expect(decisions.record).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'SKIPPED_BUDGET' }),
    );
  });
});

describe('geração de copy — o provider fora do ar não é erro', () => {
  it('persiste AI_UNAVAILABLE em vez de lançar', async () => {
    const { service, persisted } = build({ generatorThrows: true });

    const outcome = await service.generate(input);

    /**
     * A promessa da feature: o determinístico decide o que mudar e sobrevive à
     * queda da IA. O contexto e as sugestões que originaram o pedido continuam
     * gravados; o que faltou foi o texto.
     */
    expect(outcome.generation.status).toBe('AI_UNAVAILABLE');
    expect(persisted[0]).toMatchObject({
      status: 'AI_UNAVAILABLE',
      variants: [],
      context,
    });
  });

  it('registra a falha na trilha de custo', async () => {
    const { service, decisions } = build({ generatorThrows: true });

    await service.generate(input);

    expect(decisions.record).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'FAILED' }),
    );
  });
});

describe('geração de copy — o reuso', () => {
  it('devolve a geração anterior sem chamar a IA', async () => {
    const existing = storedGeneration();
    const { service, generator } = build({ existing });

    const outcome = await service.generate(input);

    expect(outcome.reused).toBe(true);
    expect(outcome.generation.id).toBe(existing.id);
    expect(generator.generate).not.toHaveBeenCalled();
  });

  it('`regenerate` ignora o reuso e chama de novo', async () => {
    // **Não é P9**: o modelo escreve outro texto a cada chamada, e regerar é um
    // pedido legítimo. O que este campo faz é torná-lo explícito.
    const { service, generator } = build({ existing: storedGeneration() });

    const outcome = await service.generate({ ...input, regenerate: true });

    expect(outcome.reused).toBe(false);
    expect(generator.generate).toHaveBeenCalledTimes(1);
  });

  /**
   * **A ordem inverteu, e é uma correção.**
   *
   * A cota era cobrada antes do reuso, então quem estava no teto era recusado
   * ao pedir um texto que já existia no banco — perdia acesso ao que já tinha
   * pago. Devolver o que já existe não produz nada e não pode consumir nada; é
   * a mesma regra que o reuso de P9 aplica na análise de criativo.
   */
  it('o reuso vem antes da cota, e não a consome', async () => {
    const { service, planEntitlement } = build({
      existing: storedGeneration(),
      used: 5,
    });

    const outcome = await service.generate(input);

    expect(outcome.reused).toBe(true);
    expect(planEntitlement.reserveQuota).not.toHaveBeenCalled();
    // O contador ainda é lido: a tela precisa dizer quanto resta.
    expect(outcome.quota.used).toBe(5);
  });

  it('devolve a reserva quando o teto diário de gasto corta depois dela', async () => {
    // A unidade sai antes do trabalho. Se o trabalho não acontece, cobrá-la
    // faria o cliente pagar por uma geração que nunca recebeu.
    const { service, planEntitlement } = build({
      spentBase: 100,
      limitBase: 10,
    });

    await expect(service.generate(input)).rejects.toMatchObject({
      code: 'AI_DAILY_BUDGET_EXHAUSTED',
    });

    expect(planEntitlement.releaseQuota).toHaveBeenCalled();
  });

  it('devolve a reserva quando o provider cai e nada é entregue', async () => {
    // `callAndPersist` não lança nessa falha — grava `AI_UNAVAILABLE` para
    // preservar o contexto. Sem a devolução, a reserva ficaria de pé.
    const { service, planEntitlement } = build({ generatorThrows: true });

    const outcome = await service.generate(input);

    expect(outcome.generation.status).toBe('AI_UNAVAILABLE');
    expect(planEntitlement.releaseQuota).toHaveBeenCalled();
  });
});

describe('geração de copy — a trilha de custo', () => {
  it('grava provider, modelo e tokens do que de fato atendeu', async () => {
    const { service, decisions } = build({});

    await service.generate(input);

    expect(decisions.record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'SUCCEEDED',
        provider: 'anthropic',
        model: 'claude-copy',
        inputTokens: 900,
        outputTokens: 700,
        taskType: 'creative_suggestion',
      }),
    );
  });

  it('não duplica o texto gerado na trilha', async () => {
    const { service, decisions } = build({});

    await service.generate(input);

    /**
     * O texto mora em `copy_variants`, que é onde ele é ativo do cliente.
     * Duplicá-lo em `AIDecisionLog` criaria uma segunda cópia de conteúdo de
     * marca numa tabela cuja política é retenção curta — e as duas divergiriam
     * no primeiro expurgo.
     */
    expect(decisions.record).toHaveBeenCalledWith(
      expect.objectContaining({ responseText: null }),
    );
  });
});
