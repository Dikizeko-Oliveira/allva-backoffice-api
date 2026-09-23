import { revalidate, type PremiseState } from './premise';
import { decideTransitions, type LifecycleCandidate } from './lifecycle';

/**
 * §9.5 passo 1 — **o que separa um copiloto de um gerador de acidentes.**
 *
 * > A recomendação é gerada num lote diário e aplicada quando o usuário clica,
 * > dias depois. No intervalo, conversões são re-declaradas retroativamente, o
 * > anúncio pode ter sido pausado na plataforma, o token pode ter expirado.
 */

function state(overrides: Partial<PremiseState> = {}): PremiseState {
  return {
    status: 'NEW',
    expiresAt: new Date(Date.now() + 86_400_000),
    suppressed: false,
    linkedWasteItems: 2,
    openWasteItems: 2,
    evidenceAsOf: new Date(),
    evidenceMaxAgeDays: 3,
    dataMaturity: 'MATURE',
    requiresMature: true,
    adArchived: false,
    adObservable: true,
    integrationReachable: true,
    capabilitySupported: true,
    consentGranted: true,
    killSwitchOn: false,
    writeInFlightId: null,
    ...overrides,
  };
}

describe('revalidação de premissa (§9.5 passo 1)', () => {
  it('premissa íntegra passa', () => {
    expect(revalidate(state())).toEqual({ valid: true, failure: null });
  });

  it('evidência vencida ⇒ falha E expira a recomendação', () => {
    // O gate do sprint: 409 tipado, expirada na hora, motivo visível.
    const verdict = revalidate(
      state({ evidenceAsOf: new Date(Date.now() - 10 * 86_400_000) }),
    );

    expect(verdict.valid).toBe(false);
    expect(verdict.failure).toMatchObject({
      check: 'EVIDENCE_FRESH',
      code: 'RECOMMENDATION_PREMISE_STALE',
      expiresRecommendation: true,
    });
    expect(verdict.failure?.reason).toContain('10 dias');
  });

  it('maturidade que deixou de ser MATURE vence a premissa', () => {
    // A atribuição pode ser reconfigurada na plataforma e reclassificar os dias:
    // o que era `MATURE` deixa de ser, e o veredito não se sustenta mais.
    const verdict = revalidate(state({ dataMaturity: 'SETTLING' }));

    expect(verdict.failure).toMatchObject({
      code: 'RECOMMENDATION_PREMISE_STALE',
      expiresRecommendation: true,
    });
  });

  it('todos os achados de origem resolvidos ⇒ premissa acabou', () => {
    const verdict = revalidate(state({ openWasteItems: 0 }));

    expect(verdict.failure).toMatchObject({
      check: 'WASTE_ITEMS_OPEN',
      code: 'RECOMMENDATION_PREMISE_RESOLVED',
      expiresRecommendation: true,
    });
  });

  it('recomendação sem achado vinculado não é barrada por isso', () => {
    // `REPLACE_CTA` nasce do score, sem achado. Exigir achado aberto a barraria
    // sempre — e ela é a única que não tem nenhum por construção.
    expect(
      revalidate(state({ linkedWasteItems: 0, openWasteItems: 0 })).valid,
    ).toBe(true);
  });

  it('anúncio arquivado bloqueia e expira', () => {
    expect(revalidate(state({ adArchived: true })).failure).toMatchObject({
      code: 'AD_NOT_ACTIONABLE',
      expiresRecommendation: true,
    });
  });

  it('integração fora do ar bloqueia SEM expirar', () => {
    // A integração volta, e o diagnóstico continua verdadeiro. Expirar aqui
    // apagaria uma recomendação correta por causa de um token vencido.
    expect(
      revalidate(state({ integrationReachable: false })).failure,
    ).toMatchObject({
      code: 'INTEGRATION_UNREACHABLE',
      expiresRecommendation: false,
    });
  });

  it('escrita em voo no alvo bloqueia sem expirar (I2 generalizada)', () => {
    expect(
      revalidate(state({ writeInFlightId: 'exec-1' })).failure,
    ).toMatchObject({ code: 'WRITE_IN_FLIGHT', expiresRecommendation: false });
  });

  it('kill switch e consentimento bloqueiam sem expirar', () => {
    expect(revalidate(state({ killSwitchOn: true })).failure).toMatchObject({
      code: 'PLATFORM_ACTIONS_DISABLED',
      expiresRecommendation: false,
    });
    expect(revalidate(state({ consentGranted: false })).failure).toMatchObject({
      code: 'WRITE_CONSENT_REQUIRED',
      expiresRecommendation: false,
    });
  });

  it('status já terminal não é aplicável, e não expira de novo', () => {
    expect(revalidate(state({ status: 'APPLIED' })).failure).toMatchObject({
      code: 'RECOMMENDATION_NOT_APPLICABLE',
      expiresRecommendation: false,
    });
  });

  it('supressão ativa barra a aplicação', () => {
    expect(revalidate(state({ suppressed: true })).failure).toMatchObject({
      code: 'RECOMMENDATION_SUPPRESSED',
    });
  });
});

/**
 * ⊕7 — **`DEFERRED_BY_CONFLICT` não pode ser terminal por acidente.**
 *
 * §16.16 é normativo: nenhum status não terminal sem caminho de saída. Quando a
 * vencedora é aplicada, o alvo fica livre — e sem o passo 8 a perdedora ficaria
 * presa fora da tela para sempre, com o problema dela seguindo em frente.
 */
describe('ciclo de vida (C5, ⊕7)', () => {
  const now = new Date('2026-08-02T12:00:00.000Z');

  function candidate(
    overrides: Partial<LifecycleCandidate> = {},
  ): LifecycleCandidate {
    return {
      id: 'reco-1',
      status: 'NEW',
      expiresAt: new Date('2026-08-09T00:00:00.000Z'),
      linkedWasteItems: 1,
      openWasteItems: 1,
      conflictWithId: null,
      conflictWinnerStatus: null,
      ...overrides,
    };
  }

  it('conflito cessado + premissa válida ⇒ volta a NEW', () => {
    const [transition] = decideTransitions(
      [
        candidate({
          status: 'DEFERRED_BY_CONFLICT',
          conflictWithId: 'reco-vencedora',
          conflictWinnerStatus: 'APPLIED',
        }),
      ],
      now,
    );

    expect(transition).toMatchObject({ to: 'NEW' });
    expect(transition.reason).toContain('volta à tela');
  });

  it('conflito cessado + premissa vencida ⇒ EXPIRED', () => {
    const [transition] = decideTransitions(
      [
        candidate({
          status: 'DEFERRED_BY_CONFLICT',
          conflictWithId: 'reco-vencedora',
          conflictWinnerStatus: 'EXPIRED',
          expiresAt: new Date('2026-08-01T00:00:00.000Z'),
        }),
      ],
      now,
    );

    expect(transition).toMatchObject({ to: 'EXPIRED' });
  });

  it('vencedora em APPLYING NÃO libera a perdedora', () => {
    // Há escrita em voo: reabilitar agora criaria a corrida que a I2 existe
    // para impedir.
    expect(
      decideTransitions(
        [
          candidate({
            status: 'DEFERRED_BY_CONFLICT',
            conflictWithId: 'reco-vencedora',
            conflictWinnerStatus: 'APPLYING',
          }),
        ],
        now,
      ),
    ).toEqual([]);
  });

  it('achados de origem resolvidos ⇒ EXPIRED', () => {
    const [transition] = decideTransitions(
      [candidate({ openWasteItems: 0 })],
      now,
    );

    expect(transition).toMatchObject({ to: 'EXPIRED' });
    expect(transition.reason).toContain('resolvidos');
  });

  it('prazo vencido ⇒ EXPIRED', () => {
    const [transition] = decideTransitions(
      [candidate({ expiresAt: new Date('2026-08-01T00:00:00.000Z') })],
      now,
    );

    expect(transition).toMatchObject({ to: 'EXPIRED' });
  });

  it('recomendação saudável não transiciona', () => {
    expect(decideTransitions([candidate()], now)).toEqual([]);
  });

  it('status terminal é ignorado', () => {
    expect(decideTransitions([candidate({ status: 'APPLIED' })], now)).toEqual(
      [],
    );
  });
});
