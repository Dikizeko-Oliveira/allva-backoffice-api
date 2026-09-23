import { resolveContractAccess } from './contract-access';
import { CLOSED_ACCESS_DAILY_SYNC_HOURS, sweepModeFor } from './sweep-mode';

/**
 * O quanto os jobs varrem uma organização, a partir do acesso dela.
 *
 * O que esta suíte protege é a promessa feita a quem perde acesso — **ao menos
 * dois dias de sync diário** — e a garantia de que essa janela nunca encurta a
 * tolerância de um contrato Enterprise.
 */

const HORA = 60 * 60 * 1000;
const DIA = 24 * HORA;
const AGORA = new Date('2026-09-14T12:00:00Z');

function modo(overrides: Partial<Parameters<typeof sweepModeFor>[0]> = {}) {
  return sweepModeFor({
    deleted: false,
    access: 'ALLOWED',
    accessClosedAt: null,
    now: AGORA,
    ...overrides,
  });
}

describe('quanto os jobs varrem uma organização', () => {
  it('acesso aberto varre tudo, inclusive no período de graça', () => {
    expect(modo({ access: 'ALLOWED' })).toBe('FULL');
    expect(modo({ access: 'GRACE_PERIOD' })).toBe('FULL');
  });

  it('acesso aberto ignora um carimbo antigo', () => {
    const antigo = new Date(AGORA.getTime() - 10 * DIA);

    expect(modo({ access: 'ALLOWED', accessClosedAt: antigo })).toBe('FULL');
  });

  it('organização excluída não é varrida, nem com acesso aberto', () => {
    expect(modo({ deleted: true, access: 'ALLOWED' })).toBe('NONE');
  });

  it('a primeira observação do fechamento abre a janela de sync diário', () => {
    for (const access of [
      'PAYMENT_REQUIRED',
      'PENDING_ACTIVATION',
      'BLOCKED',
    ] as const) {
      expect(modo({ access, accessClosedAt: null })).toBe('DAILY_SYNC_ONLY');
    }
  });

  it('a janela dura 48h a partir do carimbo, e termina nela', () => {
    const limite = CLOSED_ACCESS_DAILY_SYNC_HOURS * HORA;

    expect(
      modo({
        access: 'PAYMENT_REQUIRED',
        accessClosedAt: new Date(AGORA.getTime() - limite + 1),
      }),
    ).toBe('DAILY_SYNC_ONLY');
    expect(
      modo({
        access: 'PAYMENT_REQUIRED',
        accessClosedAt: new Date(AGORA.getTime() - limite),
      }),
    ).toBe('NONE');
  });

  it('qualquer que seja a hora do fechamento, cabem ao menos duas varreduras diárias', () => {
    // O tick diário é às 03:20; o fechamento é carimbado no tick horário (:10)
    // que primeiro o observa.
    for (let hora = 0; hora < 24; hora += 1) {
      const carimbo = new Date(Date.UTC(2026, 8, 14, hora, 10));
      const ticks = [0, 1, 2, 3].map(
        (dia) => new Date(Date.UTC(2026, 8, 14 + dia, 3, 20)),
      );

      const diarias = ticks.filter(
        (tick) =>
          tick >= carimbo &&
          modo({
            access: 'PAYMENT_REQUIRED',
            accessClosedAt: carimbo,
            now: tick,
          }) === 'DAILY_SYNC_ONLY',
      );

      expect(diarias.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('a janela de 48h e a tolerância do contrato Enterprise', () => {
  const vencimento = new Date('2026-09-01T00:00:00Z');
  const contrato = {
    status: 'ACTIVE',
    startsAt: new Date('2026-01-01T00:00:00Z'),
    endsAt: new Date('2026-12-31T00:00:00Z'),
    gracePeriodDays: 7,
    oldestUnpaidDueAt: vencimento,
  };

  function modoNo(now: Date, accessClosedAt: Date | null) {
    return sweepModeFor({
      deleted: false,
      access: resolveContractAccess(contrato, now),
      accessClosedAt,
      now,
    });
  }

  it('durante os 7 dias de tolerância a organização segue varrida por inteiro', () => {
    for (let horas = 1; horas < 8 * 24; horas += 1) {
      expect(modoNo(new Date(vencimento.getTime() + horas * HORA), null)).toBe(
        'FULL',
      );
    }
  });

  it('a janela só abre quando a tolerância acaba, e dura 48h depois dela', () => {
    // Oito dias inteiros de atraso: o primeiro instante fora dos sete de graça.
    const fimDaTolerancia = new Date(vencimento.getTime() + 8 * DIA);

    expect(resolveContractAccess(contrato, fimDaTolerancia)).toBe(
      'PAYMENT_REQUIRED',
    );
    expect(modoNo(fimDaTolerancia, null)).toBe('DAILY_SYNC_ONLY');
    expect(
      modoNo(new Date(fimDaTolerancia.getTime() + 47 * HORA), fimDaTolerancia),
    ).toBe('DAILY_SYNC_ONLY');
    expect(
      modoNo(new Date(fimDaTolerancia.getTime() + 48 * HORA), fimDaTolerancia),
    ).toBe('NONE');
  });

  it('a baixa da fatura durante a janela devolve a varredura completa', () => {
    const agora = new Date(vencimento.getTime() + 9 * DIA);
    const pago = { ...contrato, oldestUnpaidDueAt: null };

    expect(
      sweepModeFor({
        deleted: false,
        access: resolveContractAccess(pago, agora),
        accessClosedAt: new Date(vencimento.getTime() + 8 * DIA),
        now: agora,
      }),
    ).toBe('FULL');
  });
});
