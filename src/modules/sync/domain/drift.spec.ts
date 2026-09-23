import {
  DRIFT_GRACE_MS,
  VERIFICATION_LADDER_MS,
  detectExternalChange,
  evaluateDrift,
  evaluateFreshness,
  probableExternalCause,
} from './drift';

const setAt = new Date('2026-08-01T14:00:00Z');

function at(msAfter: number): Date {
  return new Date(setAt.getTime() + msAfter);
}

describe('(a) drift contra a nossa intenção (§8.5a)', () => {
  it('confirma quando o observado casa com o desejado', () => {
    expect(
      evaluateDrift({
        observedStatus: 'PAUSED',
        desiredStatus: 'PAUSED',
        desiredStatusSetAt: setAt,
        attempt: 0,
        now: at(60_000),
      }),
    ).toEqual({ kind: 'IN_SYNC' });
  });

  it('não alarma dentro da graça de 5 minutos', () => {
    // Meta processa de forma assíncrona: os primeiros minutos depois de uma
    // escrita são o caso normal de divergência, não o sintoma.
    const verdict = evaluateDrift({
      observedStatus: 'ACTIVE',
      desiredStatus: 'PAUSED',
      desiredStatusSetAt: setAt,
      attempt: 0,
      now: at(DRIFT_GRACE_MS - 1),
    });

    expect(verdict.kind).toBe('WITHIN_GRACE');
  });

  it('agenda o próximo degrau a partir do instante da escrita', () => {
    // A escada é contada de `desiredStatusSetAt`, não do relógio do worker: um
    // reconcile atrasado não pode consumir três degraus de uma vez.
    const verdict = evaluateDrift({
      observedStatus: 'ACTIVE',
      desiredStatus: 'PAUSED',
      desiredStatusSetAt: setAt,
      attempt: 1,
      now: at(DRIFT_GRACE_MS + 1),
    });

    expect(verdict).toMatchObject({ kind: 'PENDING', attempt: 2 });
    if (verdict.kind === 'PENDING') {
      expect(verdict.nextAttemptAt).toEqual(at(VERIFICATION_LADDER_MS[1]));
    }
  });

  it('declara UNVERIFIED_WRITE quando a escada esgota', () => {
    // É este ramo que impede o travamento permanente: sem estado terminal, I2
    // manteria o anúncio indefinidamente sem aceitar novas ações, em silêncio.
    expect(
      evaluateDrift({
        observedStatus: 'ACTIVE',
        desiredStatus: 'PAUSED',
        desiredStatusSetAt: setAt,
        attempt: VERIFICATION_LADDER_MS.length,
        now: at(10_000_000),
      }),
    ).toMatchObject({ kind: 'DRIFTED', cause: 'UNVERIFIED_WRITE' });
  });
});

describe('(b) mudança externa (§8.5b)', () => {
  it('reporta alteração que não pedimos, com causa provável', () => {
    expect(
      detectExternalChange({
        previousObserved: 'ACTIVE',
        observedStatus: 'DISAPPROVED',
        desiredStatus: null,
      }),
    ).toEqual({
      from: 'ACTIVE',
      to: 'DISAPPROVED',
      cause: 'PLATFORM_REJECTED',
    });
  });

  it('não reporta quando há intenção nossa em voo', () => {
    // Seria a própria escrita da Allva aparecendo como "alguém mexeu no seu
    // anúncio". A divergência com intenção em voo é assunto do ramo (a).
    expect(
      detectExternalChange({
        previousObserved: 'ACTIVE',
        observedStatus: 'PAUSED',
        desiredStatus: 'PAUSED',
      }),
    ).toBeNull();
  });

  it.each([
    ['PENDING_REVIEW', 'PLATFORM_REVIEW'],
    ['DISAPPROVED', 'PLATFORM_REJECTED'],
    ['PAUSED', 'OPERATOR_OR_RULE'],
    ['ARCHIVED', 'REMOVED_ON_PLATFORM'],
    ['DELETED', 'REMOVED_ON_PLATFORM'],
    ['ACTIVE', 'UNKNOWN'],
  ] as const)('atribui a %s a causa provável %s', (status, cause) => {
    // "Mudou" sem causa é um alerta que ninguém sabe o que fazer com: uma
    // reprovação da plataforma e um operador que pausou pedem telas diferentes.
    expect(probableExternalCause(status)).toBe(cause);
  });

  it('não reporta a partir de UNKNOWN', () => {
    // Sem base para afirmar mudança, o primeiro ciclo depois do deploy geraria
    // uma enxurrada de alertas sobre nada.
    expect(
      detectExternalChange({
        previousObserved: 'UNKNOWN',
        observedStatus: 'ACTIVE',
        desiredStatus: null,
      }),
    ).toBeNull();
  });
});

describe('(c) frescor (§8.5c)', () => {
  const now = new Date('2026-08-01T14:00:00Z');

  it('métrica velha é STALE, não UNREACHABLE', () => {
    // A diferença tem consequência: um `STALE` continua apto a receber ação.
    expect(
      evaluateFreshness({
        lastMetricsSyncAt: new Date('2026-07-30T14:00:00Z'),
        lastStructureSyncAt: new Date('2026-08-01T13:00:00Z'),
        integrationAvailable: true,
        now,
      }),
    ).toBe('STALE');
  });

  it('estrutura velha é UNREACHABLE', () => {
    expect(
      evaluateFreshness({
        lastMetricsSyncAt: new Date('2026-08-01T13:00:00Z'),
        lastStructureSyncAt: new Date('2026-07-25T14:00:00Z'),
        integrationAvailable: true,
        now,
      }),
    ).toBe('UNREACHABLE');
  });

  it('integração indisponível é UNREACHABLE independentemente das datas', () => {
    expect(
      evaluateFreshness({
        lastMetricsSyncAt: now,
        lastStructureSyncAt: now,
        integrationAvailable: false,
        now,
      }),
    ).toBe('UNREACHABLE');
  });

  it('honra os SLAs informados em vez dos padrões', () => {
    expect(
      evaluateFreshness({
        lastMetricsSyncAt: new Date('2026-08-01T11:00:00Z'),
        lastStructureSyncAt: new Date('2026-08-01T11:00:00Z'),
        integrationAvailable: true,
        now,
        metricsSlaHours: 1,
        structureSlaHours: 48,
      }),
    ).toBe('STALE');
  });

  it('nunca sincronizado é UNREACHABLE, não FRESH', () => {
    expect(
      evaluateFreshness({
        lastMetricsSyncAt: null,
        lastStructureSyncAt: null,
        integrationAvailable: true,
        now,
      }),
    ).toBe('UNREACHABLE');
  });
});
