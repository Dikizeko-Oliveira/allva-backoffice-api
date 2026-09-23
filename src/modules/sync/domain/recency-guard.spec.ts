import { evaluateRecency, resolveObservedAsOf } from './recency-guard';

describe('observedAsOf e o fallback declarado (§8.4.1, B4)', () => {
  const syncStartedAt = new Date('2026-08-01T14:00:00Z');
  const platformTimestamp = new Date('2026-08-01T14:03:00Z');

  it('usa o instante da plataforma quando o perfil o expõe', () => {
    expect(
      resolveObservedAsOf({
        platformTimestamp,
        syncStartedAt,
        exposesDataTimestamp: true,
      }),
    ).toEqual({ observedAsOf: platformTimestamp, source: 'PLATFORM' });
  });

  it('cai para o início da leitura quando a plataforma não expõe', () => {
    // Google e TikTok declaram `exposesDataTimestamp: false`. Sem este fallback
    // a guarda ficaria **indefinida** nessas plataformas — e ela é justamente a
    // proteção contra o produto alertar sobre uma divergência que ele criou.
    expect(
      resolveObservedAsOf({
        platformTimestamp: null,
        syncStartedAt,
        exposesDataTimestamp: false,
      }),
    ).toEqual({ observedAsOf: syncStartedAt, source: 'SYNC_START' });
  });

  it('ignora o timestamp mesmo presente quando o perfil diz que não é confiável', () => {
    expect(
      resolveObservedAsOf({
        platformTimestamp,
        syncStartedAt,
        exposesDataTimestamp: false,
      }).source,
    ).toBe('SYNC_START');
  });
});

describe('guarda de recência (§8.4.1)', () => {
  const observed = {
    observedAsOf: new Date('2026-08-01T14:05:00Z'),
    source: 'PLATFORM' as const,
  };

  it('grava o status quando não há intenção nossa em voo', () => {
    expect(
      evaluateRecency({ observed, desiredStatusSetAt: null }).writeStatus,
    ).toBe(true);
  });

  it('grava quando a observação é mais nova que a intenção', () => {
    expect(
      evaluateRecency({
        observed,
        desiredStatusSetAt: new Date('2026-08-01T14:00:00Z'),
      }).writeStatus,
    ).toBe(true);
  });

  it('IGNORA o status quando a observação é anterior à intenção', () => {
    // O cenário comum, não a exceção: um ingest iniciado antes da ação e
    // concluído depois gravaria um status obsoleto, e a reconciliação
    // declararia `DRIFTED` num anúncio que obedeceu.
    const verdict = evaluateRecency({
      observed,
      desiredStatusSetAt: new Date('2026-08-01T14:10:00Z'),
    });

    expect(verdict.writeStatus).toBe(false);
    expect(verdict.reason).toContain('não é mais nova');
  });

  it('empate perde: dado do mesmo instante não pode ter incorporado a escrita', () => {
    expect(
      evaluateRecency({
        observed,
        desiredStatusSetAt: observed.observedAsOf,
      }).writeStatus,
    ).toBe(false);
  });

  it('propaga a origem do instante para quem for registrar a substituição', () => {
    expect(
      evaluateRecency({
        observed: { observedAsOf: new Date(), source: 'SYNC_START' },
        desiredStatusSetAt: null,
      }).observedAsOfSource,
    ).toBe('SYNC_START');
  });
});
