import type { AdStatus } from 'src/modules/ads/domain/platform/platform-profile';
import { deriveRevertParameters, inverseActionOf } from './revert';

const toCanonical = (raw: string): AdStatus =>
  (({ ACTIVE: 'ACTIVE', PAUSED: 'PAUSED', ARCHIVED: 'ARCHIVED' })[raw] ??
    'UNKNOWN') as AdStatus;

function derive(
  overrides: Partial<Parameters<typeof deriveRevertParameters>[0]> = {},
) {
  return deriveRevertParameters({
    actionType: 'ENABLE_AD',
    previousState: { status: 'ACTIVE' },
    originalParameters: { adId: 'ad-1' },
    accountCurrency: 'BRL',
    toCanonical,
    ...overrides,
  });
}

describe('§9.6 — a ação inversa', () => {
  /**
   * Reverter um `PAUSE_AD` é um `ENABLE_AD`, não um `PAUSE_AD` com parâmetro
   * trocado: a plataforma tem caminhos diferentes por tipo, e a capability é
   * declarada por tipo.
   */
  it('inverte pausar e reativar em todos os níveis', () => {
    expect(inverseActionOf('PAUSE_AD')).toBe('ENABLE_AD');
    expect(inverseActionOf('ENABLE_AD')).toBe('PAUSE_AD');
    expect(inverseActionOf('PAUSE_CAMPAIGN')).toBe('ENABLE_CAMPAIGN');
  });

  it('mantém o tipo nas ações de orçamento — o inverso é outro valor', () => {
    expect(inverseActionOf('ADJUST_AD_SET_BUDGET')).toBe(
      'ADJUST_AD_SET_BUDGET',
    );
  });

  /**
   * O que arquiva ou recria não volta por escrita. Declarar `null` faz o
   * caminho recusar com motivo, em vez de tentar e receber o erro da plataforma
   * depois de já ter gravado a intenção.
   */
  it('não declara inverso para o que não volta', () => {
    expect(inverseActionOf('ARCHIVE_AD')).toBeNull();
    expect(inverseActionOf('DUPLICATE_AD')).toBeNull();
    expect(inverseActionOf('REPLACE_COPY')).toBeNull();
  });
});

describe('derivação a partir de previousState', () => {
  it('restaura o status capturado antes da escrita', () => {
    const result = derive();

    expect(result).toMatchObject({ derivable: true, desiredStatus: 'ACTIVE' });
  });

  /**
   * **Reverter sem estado anterior é inventar um estado.** Um default aqui
   * restauraria algo que nunca existiu, e o usuário leria "revertido" sobre uma
   * terceira escrita arbitrária.
   */
  it('recusa quando não há estado anterior', () => {
    expect(derive({ previousState: null })).toMatchObject({ derivable: false });
  });

  it('recusa quando o estado anterior não tem status', () => {
    expect(derive({ previousState: {} })).toMatchObject({ derivable: false });
  });

  /**
   * `ARCHIVED` é irreversível por §13.1 e `UNKNOWN` significa que não soubemos
   * ler. Restaurar qualquer um dos dois seria escrever com base numa leitura que
   * não entendemos.
   */
  it.each(['ARCHIVED', 'ALGO_NOVO'])(
    'recusa restaurar o estado %s',
    (status) => {
      const result = derive({ previousState: { status } });

      expect(result.derivable).toBe(false);
    },
  );

  describe('orçamento', () => {
    const budget = {
      actionType: 'ADJUST_AD_SET_BUDGET' as const,
      previousState: { dailyBudgetMinor: '9900' },
      originalParameters: {
        adSetId: 'set-1',
        dailyBudget: 150.5,
        previousDailyBudget: 99,
        currency: 'BRL',
      },
    };

    it('converte a unidade menor pela moeda da conta', () => {
      const result = derive(budget);

      expect(result).toMatchObject({
        derivable: true,
        parameters: expect.objectContaining({ dailyBudget: 99 }),
      });
    });

    it('respeita moedas sem casa decimal', () => {
      const result = derive({
        ...budget,
        previousState: { dailyBudgetMinor: '50000' },
        accountCurrency: 'JPY',
        originalParameters: { ...budget.originalParameters, currency: 'JPY' },
      });

      expect(result).toMatchObject({
        parameters: expect.objectContaining({ dailyBudget: 50_000 }),
      });
    });

    /**
     * O valor **atual** vira o `previousDailyBudget` da reversão. Copiar o campo
     * da ação original faria uma segunda reversão pular um degrau da história e
     * restaurar o estado de antes da primeira.
     */
    it('registra o valor corrente como o anterior da próxima reversão', () => {
      const result = derive(budget);

      expect(result).toMatchObject({
        parameters: expect.objectContaining({ previousDailyBudget: 150.5 }),
      });
    });

    it('recusa quando o orçamento anterior não foi registrado', () => {
      expect(
        derive({ ...budget, previousState: { status: 'ACTIVE' } }),
      ).toMatchObject({ derivable: false });
    });

    it('recusa restaurar orçamento não positivo', () => {
      expect(
        derive({ ...budget, previousState: { dailyBudgetMinor: '0' } }),
      ).toMatchObject({ derivable: false });
    });
  });
});
