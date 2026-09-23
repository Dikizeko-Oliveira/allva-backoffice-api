import {
  AdSyncState,
  InvalidSyncStateTransitionError,
  canTransition,
  isStaleForDisplay,
  transitionSyncState,
} from './ad-sync-state';
import {
  deriveLineage,
  startLineage,
  assertLineage,
  BrokenLineageError,
} from './ad-lineage';

describe('máquina de syncState (I4)', () => {
  it('deixa o sync levar qualquer estado a IN_SYNC', () => {
    const states: AdSyncState[] = [
      'IN_SYNC',
      'PENDING_WRITE',
      'DRIFTED',
      'STALE',
      'UNREACHABLE',
    ];

    for (const from of states) {
      expect(
        canTransition({ from, to: 'IN_SYNC', actor: 'sync' }).allowed,
      ).toBe(true);
    }
  });

  it('deixa platform-actions apenas reservar a escrita', () => {
    expect(
      canTransition({
        from: 'IN_SYNC',
        to: 'PENDING_WRITE',
        actor: 'platform-actions',
      }).allowed,
    ).toBe(true);
    expect(
      canTransition({
        from: 'STALE',
        to: 'PENDING_WRITE',
        actor: 'platform-actions',
      }).allowed,
    ).toBe(true);
  });

  /**
   * A regra que costuma faltar: quem escreve **não** declara o próprio sucesso.
   * Deixar `platform-actions` sair de `PENDING_WRITE` é como o produto passaria
   * a reportar "pausado" para um anúncio que a plataforma recusou.
   */
  it('impede platform-actions de sair de PENDING_WRITE', () => {
    const verdict = canTransition({
      from: 'PENDING_WRITE',
      to: 'IN_SYNC',
      actor: 'platform-actions',
    });

    expect(verdict.allowed).toBe(false);
    expect(verdict).toMatchObject({
      reason: expect.stringContaining('PENDING_WRITE'),
    });
  });

  it('impede platform-actions de tocar em DRIFTED ou UNREACHABLE', () => {
    expect(
      canTransition({
        from: 'DRIFTED',
        to: 'IN_SYNC',
        actor: 'platform-actions',
      }).allowed,
    ).toBe(false);
    expect(
      canTransition({
        from: 'IN_SYNC',
        to: 'UNREACHABLE',
        actor: 'platform-actions',
      }).allowed,
    ).toBe(false);
  });

  it('levanta com o motivo, em vez de devolver o estado errado', () => {
    expect(() =>
      transitionSyncState({
        from: 'PENDING_WRITE',
        to: 'IN_SYNC',
        actor: 'platform-actions',
      }),
    ).toThrow(InvalidSyncStateTransitionError);
  });

  it('aplica a transição válida', () => {
    expect(
      transitionSyncState({ from: 'STALE', to: 'IN_SYNC', actor: 'sync' }),
    ).toBe('IN_SYNC');
  });

  it('trata PENDING_WRITE como não confiável para exibição', () => {
    // A UI mostra "pausando…", não "pausado": a plataforma pode levar minutos,
    // ou recusar.
    expect(isStaleForDisplay('PENDING_WRITE')).toBe(true);
    expect(isStaleForDisplay('IN_SYNC')).toBe(false);
  });
});

describe('linhagem (I6, §3.6)', () => {
  it('um anúncio descoberto é a origem da própria linhagem', () => {
    expect(startLineage('ad-1')).toEqual({
      lineageId: 'ad-1',
      originAdId: null,
      originActionExecutionId: null,
    });
  });

  it('o derivado herda a linhagem do pai, não o id do pai', () => {
    const first = startLineage('ad-1');
    const second = deriveLineage({
      origin: first,
      originAdId: 'ad-1',
      originActionExecutionId: 'exec-1',
    });
    // Terceira geração: continua na linhagem original.
    const third = deriveLineage({
      origin: second,
      originAdId: 'ad-2',
      originActionExecutionId: 'exec-2',
    });

    expect(second.lineageId).toBe('ad-1');
    expect(third.lineageId).toBe('ad-1');
    expect(third.originAdId).toBe('ad-2');
  });

  it('recusa anúncio sem linhagem', () => {
    expect(() => assertLineage({ id: 'ad-9', lineageId: null })).toThrow(
      BrokenLineageError,
    );
    expect(() =>
      assertLineage({ id: 'ad-9', lineageId: 'ad-9' }),
    ).not.toThrow();
  });
});
