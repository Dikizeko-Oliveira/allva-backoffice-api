import { Operator } from 'src/modules/auth/domain/entities';
import { AttentionCountsReaderInterface } from 'src/modules/operations-hub/domain/ports';
import { GetOperatorAttentionUseCase } from './get-operator-attention.usecase';

const operatorWith = (permissions: string[]) =>
  Operator.restore({
    id: 'op-1',
    name: 'Ana',
    email: 'ana@allva.com',
    platformRole: 'ALLVA_SUPPORT',
    permissions,
    accessToken: 'token',
  });

function build(
  overrides: Partial<
    Record<keyof AttentionCountsReaderInterface, jest.Mock>
  > = {},
) {
  const reader = {
    countSupport: jest.fn().mockResolvedValue({}),
    countUnacknowledgedAlerts: jest.fn().mockResolvedValue([]),
    ...overrides,
  };

  return {
    useCase: new GetOperatorAttentionUseCase(
      reader as unknown as AttentionCountsReaderInterface,
    ),
    countSupport: reader.countSupport,
  };
}

describe('GetOperatorAttentionUseCase', () => {
  it('sem support:read, não conta nem devolve sinal de atendimento', async () => {
    const { useCase, countSupport } = build();

    const result = await useCase.execute(operatorWith(['billing:read']));

    expect(result.signals).toEqual([]);
    expect(countSupport).toHaveBeenCalledWith([], 'op-1', expect.any(Date));
  });

  it('contagem que falhou volta como null, não zero', async () => {
    const { useCase } = build({
      countSupport: jest.fn().mockResolvedValue({ 'support.sla_breached': 0 }),
    });

    const result = await useCase.execute(operatorWith(['support:read']));
    const byKey = Object.fromEntries(
      result.signals.map((signal) => [signal.key, signal.count]),
    );

    expect(byKey['support.sla_breached']).toBe(0);
    expect(byKey['support.sla_at_risk']).toBeNull();
  });

  it('ordena por severidade, com alertas no meio', async () => {
    const { useCase } = build({
      countUnacknowledgedAlerts: jest
        .fn()
        .mockResolvedValue([
          { permission: 'support:read', severity: 'CRITICAL', count: 2 },
        ]),
    });

    const result = await useCase.execute(operatorWith(['support:read']));

    expect(result.signals.map((signal) => signal.severity)).toEqual([
      'CRITICAL',
      'CRITICAL',
      'WARNING',
      'WARNING',
      'INFO',
    ]);
    expect(result.signals[0].key).toBe('support.sla_breached');
    expect(result.signals[1].key).toBe('alerts.unacknowledged');
  });
});
