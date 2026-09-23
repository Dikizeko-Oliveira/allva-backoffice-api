import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { AttentionSignalKey } from 'src/modules/operations-hub/domain/attention-signals';
import { GetOperatorAttentionUseCase } from './get-operator-attention.usecase';

const NOW = new Date('2026-09-22T12:00:00.000Z');

function setup(
  role: string | null,
  counts: Partial<Record<AttentionSignalKey, number>> = {},
) {
  const accountsRepository = {
    findById: jest
      .fn()
      .mockResolvedValue(role === null ? null : { id: 'op-1', role }),
  };
  const countsReader = { count: jest.fn().mockResolvedValue(counts) };
  const useCase = new GetOperatorAttentionUseCase(
    accountsRepository as never,
    countsReader as never,
  );

  return { useCase, countsReader };
}

describe('GetOperatorAttentionUseCase', () => {
  it('recusa conta de cliente com o código das superfícies administrativas', async () => {
    const { useCase, countsReader } = setup('USER');

    await expect(useCase.execute('op-1', NOW)).rejects.toThrow(
      ForbiddenException,
    );
    expect(countsReader.count).not.toHaveBeenCalled();
  });

  it('conta inexistente é 404, não 403', async () => {
    const { useCase } = setup(null);

    await expect(useCase.execute('op-1', NOW)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('só pede ao leitor os sinais da área do operador', async () => {
    const { useCase, countsReader } = setup('ALLVA_SALES', {
      'leads.awaiting_qualification': 3,
    });

    const output = await useCase.execute('op-1', NOW);

    expect(countsReader.count).toHaveBeenCalledWith(
      ['leads.awaiting_qualification'],
      NOW,
    );
    expect(output).toEqual({
      generatedAt: NOW.toISOString(),
      signals: [
        {
          key: 'leads.awaiting_qualification',
          permission: 'leads:read',
          severity: 'INFO',
          count: 3,
        },
      ],
    });
  });

  it('contagem que falhou volta como null, e zero continua zero', async () => {
    const { useCase } = setup('ALLVA_SUPPORT', {
      'support.tickets_unassigned': 0,
    });

    const { signals } = await useCase.execute('op-1', NOW);
    const byKey = new Map(signals.map((signal) => [signal.key, signal.count]));

    expect(byKey.get('support.tickets_unassigned')).toBe(0);
    expect(byKey.get('contacts.unread')).toBeNull();
  });

  it('ordena por severidade, crítico primeiro', async () => {
    const { useCase } = setup('ALLVA_ADMIN');

    const { signals } = await useCase.execute('op-1', NOW);
    const rank = { CRITICAL: 0, WARNING: 1, INFO: 2 } as const;
    const ranks = signals.map((signal) => rank[signal.severity]);

    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });
});
