import { GetDailyDigestUseCase } from './get-daily-digest.usecase';

function buildHarness({
  organizationId = 'org-1',
  digest = null,
}: {
  organizationId?: string | null;
  digest?: Record<string, unknown> | null;
} = {}) {
  const digests = { latestFor: jest.fn().mockResolvedValue(digest) };
  const scope = {
    resolveForAccount: jest
      .fn()
      .mockResolvedValue({ accountId: 'account-1', organizationId }),
  };

  return {
    useCase: new GetDailyDigestUseCase(digests as never, scope as never),
    digests,
  };
}

/**
 * A rota é `@IntelligenceRoute()`: fora de produção o interceptor **lança**
 * quando falta `asOf` ou `provenance` — e ele cobra os dois também com
 * `data: null`. Foi assim que "ainda não há resumo" virou 500.
 */
describe('GetDailyDigestUseCase', () => {
  it('sem resumo gravado, devolve null com asOf e provenance', async () => {
    const { useCase } = buildHarness({ digest: null });

    const result = await useCase.execute('account-1');

    expect(result.data).toBeNull();
    expect(result.meta.asOf).toBeDefined();
    expect(result.meta.provenance).toBeDefined();
  });

  it('sem organização, devolve null com asOf e provenance sem ler resumo', async () => {
    const { useCase, digests } = buildHarness({ organizationId: null });

    const result = await useCase.execute('account-1');

    expect(result.data).toBeNull();
    expect(result.meta.asOf).toBeDefined();
    expect(result.meta.provenance).toBeDefined();
    expect(digests.latestFor).not.toHaveBeenCalled();
  });

  it('com resumo, asOf é o dia do resumo e não o instante da resposta', async () => {
    const { useCase } = buildHarness({
      digest: {
        digestDate: new Date('2026-09-14T00:00:00.000Z'),
        inputDigest: 'hash',
        facts: { periodDays: 7 },
        narrative: 'Texto.',
        enrichedByAI: false,
        promptVersion: null,
        reusedFromDate: null,
      },
    });

    const result = await useCase.execute('account-1');

    expect(result.data).toMatchObject({ digestDate: '2026-09-14' });
    expect(result.meta.asOf).toBe('2026-09-14T00:00:00.000Z');
    expect(result.meta.provenance).toEqual({});
  });
});
