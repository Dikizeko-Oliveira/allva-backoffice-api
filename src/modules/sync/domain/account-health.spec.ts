import {
  degradationFor,
  healthFromIngest,
  nextUnreachableSince,
} from './account-health';
import { evaluateQuarantineItem } from './quarantine';
import {
  restatementWindow,
  shouldRunFullScan,
  updatedSinceFor,
  windowKeyFor,
} from './sync-window';

describe('saúde da conta (DEC-8/D17)', () => {
  it('resposta incompleta leva a UNREACHABLE — é a metade da correção de §8.2', () => {
    expect(healthFromIngest({ wasComplete: false, failedSteps: [] })).toEqual({
      health: 'UNREACHABLE',
      reason: 'INCOMPLETE_RESPONSE',
    });
  });

  it('leitura completa e sem falha é HEALTHY', () => {
    expect(healthFromIngest({ wasComplete: true, failedSteps: [] })).toEqual({
      health: 'HEALTHY',
      reason: 'RECOVERED',
    });
  });

  it('causa de acesso que não é perda de acesso degrada, não isola', () => {
    expect(
      healthFromIngest({
        wasComplete: true,
        failedSteps: [],
        accessFailure: 'METRICS_STALE',
      }),
    ).toEqual({ health: 'DEGRADED', reason: 'METRICS_STALE' });
  });

  it('etapa falha com resposta completa é DEGRADED, não UNREACHABLE', () => {
    expect(
      healthFromIngest({ wasComplete: true, failedSteps: ['CREATIVES'] }),
    ).toEqual({ health: 'DEGRADED', reason: 'PARTIAL_INGEST' });
  });

  it('credencial expirada é perda de acesso, não leitura parcial', () => {
    expect(
      healthFromIngest({
        wasComplete: false,
        failedSteps: [],
        accessFailure: 'CREDENTIAL_EXPIRED',
      }),
    ).toMatchObject({ health: 'UNREACHABLE', reason: 'CREDENTIAL_EXPIRED' });
  });
});

describe('tabela de degradação (§8.7)', () => {
  it('DEGRADED pausa inteligência mas **permite ações**', () => {
    // A mídia continua alcançável: pausar um anúncio caro ainda funciona e ainda
    // é a coisa certa. É a leitura que está degradada, não o acesso.
    expect(degradationFor('DEGRADED')).toMatchObject({
      scoring: false,
      detection: false,
      actions: true,
      archiving: false,
    });
  });

  it('UNREACHABLE bloqueia ações e arquivamento', () => {
    expect(degradationFor('UNREACHABLE')).toMatchObject({
      ingest: 'FAILS_AND_REPORTS',
      actions: false,
      archiving: false,
    });
  });

  it('nenhum estado além de HEALTHY autoriza arquivamento', () => {
    expect(degradationFor('HEALTHY').archiving).toBe(true);
    expect(degradationFor('DEGRADED').archiving).toBe(false);
    expect(degradationFor('UNREACHABLE').archiving).toBe(false);
  });
});

describe('unreachableSince', () => {
  const first = new Date('2026-07-28T00:00:00Z');
  const now = new Date('2026-08-01T00:00:00Z');

  it('preserva o instante de entrada enquanto o estado durar', () => {
    // Reescrever a cada tentativa faria "há quanto tempo esta conta está cega"
    // ser sempre "alguns minutos" — a única informação que a coluna dá.
    expect(
      nextUnreachableSince({
        current: first,
        previousHealth: 'UNREACHABLE',
        nextHealth: 'UNREACHABLE',
        now,
      }),
    ).toEqual(first);
  });

  it('carimba na entrada e limpa na saída', () => {
    expect(
      nextUnreachableSince({
        current: null,
        previousHealth: 'HEALTHY',
        nextHealth: 'UNREACHABLE',
        now,
      }),
    ).toEqual(now);

    expect(
      nextUnreachableSince({
        current: first,
        previousHealth: 'UNREACHABLE',
        nextHealth: 'HEALTHY',
        now,
      }),
    ).toBeNull();
  });
});

describe('quarentena resolvível (C6)', () => {
  const item = {
    externalAdId: 'ad-1',
    attempts: 1,
    reason: 'CAMPAIGN_NOT_RESOLVED' as const,
  };

  it('entra no domínio assim que o pai aparece', () => {
    expect(
      evaluateQuarantineItem({
        item,
        stillPresent: true,
        parentResolvable: true,
      }),
    ).toEqual({ kind: 'RESOLVE', resolution: 'PARENT_APPEARED' });
  });

  it('resolve pelo pai mesmo com tentativas esgotadas', () => {
    // Abandonar o que acabou de virar resolvível seria perder o anúncio no exato
    // momento em que deixou de haver motivo para perdê-lo.
    expect(
      evaluateQuarantineItem({
        item: { ...item, attempts: 999 },
        stillPresent: true,
        parentResolvable: true,
      }),
    ).toEqual({ kind: 'RESOLVE', resolution: 'PARENT_APPEARED' });
  });

  it('continua esperando enquanto houver tentativa', () => {
    expect(
      evaluateQuarantineItem({
        item,
        stillPresent: true,
        parentResolvable: false,
      }),
    ).toEqual({ kind: 'RETAIN' });
  });

  it('some da plataforma antes de o pai chegar', () => {
    expect(
      evaluateQuarantineItem({
        item,
        stillPresent: false,
        parentResolvable: false,
      }),
    ).toEqual({ kind: 'RESOLVE', resolution: 'AD_DISAPPEARED' });
  });

  it('abandona de forma declarada, nunca apagando a linha', () => {
    expect(
      evaluateQuarantineItem({
        item: { ...item, attempts: 30 },
        stillPresent: true,
        parentResolvable: false,
      }),
    ).toEqual({ kind: 'RESOLVE', resolution: 'ABANDONED' });
  });
});

describe('janelas de sync', () => {
  const now = new Date('2026-08-01T14:37:00Z');

  it('a janela de re-declaração inclui hoje e cobre N dias', () => {
    const window = restatementWindow(now, 14);

    expect(window.until.toISOString().slice(0, 10)).toBe('2026-08-01');
    expect(window.since.toISOString().slice(0, 10)).toBe('2026-07-19');
  });

  it('a chave de janela distingue hora, dia, mês e o balde de 5 minutos', () => {
    expect(windowKeyFor('HOURLY', now)).toBe('2026-08-01T14');
    expect(windowKeyFor('DAILY', now)).toBe('2026-08-01');
    expect(windowKeyFor('MONTHLY', now)).toBe('2026-08');
    // 14h37 cai no balde das 14h35 — o reaper de 5 min de A2-S7 precisa que
    // duas execuções do mesmo balde disputem a **mesma** chave.
    expect(windowKeyFor('FIVE_MINUTES', now)).toBe('2026-08-01T14:35');
  });

  it('plataforma sem updated_since sempre faz varredura completa', () => {
    // Não é escolha: sem incremental, toda leitura é completa por construção.
    expect(
      shouldRunFullScan({
        lastSuccessfulFullSyncAt: now,
        supportsUpdatedSince: false,
        now,
      }),
    ).toBe(true);
  });

  it('varredura completa volta a acontecer a cada 24h', () => {
    const yesterday = new Date(now.getTime() - 25 * 3_600_000);

    expect(
      shouldRunFullScan({
        lastSuccessfulFullSyncAt: yesterday,
        supportsUpdatedSince: true,
        now,
      }),
    ).toBe(true);
  });

  it('o updated_since tem folga para trás, e não existe em varredura completa', () => {
    const last = new Date('2026-08-01T13:00:00Z');

    expect(
      updatedSinceFor({ lastStructureSyncAt: last, fullScan: false }),
    ).toEqual(new Date('2026-08-01T12:50:00Z'));

    expect(
      updatedSinceFor({ lastStructureSyncAt: last, fullScan: true }),
    ).toBeNull();
  });
});
