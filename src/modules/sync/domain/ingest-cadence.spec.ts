import { isIngestHour } from './ingest-cadence';

const SP = 'America/Sao_Paulo';

/** O instante UTC em que o relógio de São Paulo marca `hour`. */
function atSaoPauloHour(hour: number): Date {
  return new Date(Date.UTC(2026, 7, 20, (hour + 3) % 24, 10, 0));
}

describe('a peneira horária da ingestão', () => {
  it('intervalo de 1h passa em toda hora — é o cron sem peneira', () => {
    for (let hour = 0; hour < 24; hour++) {
      expect(
        isIngestHour({
          intervalHours: 1,
          now: atSaoPauloHour(hour),
          timeZone: SP,
        }),
      ).toBe(true);
    }
  });

  it('intervalo de 4h passa seis vezes por dia, em passo fixo', () => {
    const passing = Array.from({ length: 24 }, (_, hour) => hour).filter(
      (hour) =>
        isIngestHour({
          intervalHours: 4,
          now: atSaoPauloHour(hour),
          timeZone: SP,
        }),
    );

    expect(passing).toEqual([0, 4, 8, 12, 16, 20]);
  });

  it('lê a hora no fuso do agendamento, não no do processo', () => {
    /**
     * O defeito que o parâmetro existe para impedir. Às 03:10 UTC o relógio de
     * São Paulo marca 00:10 — hora de ingerir para quem tem intervalo de 4h.
     * Um `getHours()` num servidor em UTC leria 3 e pularia a janela; a conta
     * sincronizaria às 04:10 locais todo dia, uma hora fora do passo anunciado.
     */
    const tresDaManhaUtc = new Date('2026-08-20T03:10:00.000Z');

    expect(
      isIngestHour({ intervalHours: 4, now: tresDaManhaUtc, timeZone: SP }),
    ).toBe(true);
    expect(
      isIngestHour({ intervalHours: 4, now: tresDaManhaUtc, timeZone: 'UTC' }),
    ).toBe(false);
  });

  it('intervalo inválido degrada para horário, nunca para nunca', () => {
    // Um zero vindo de configuração ruim faria `hour % 0` ser NaN, e a conta
    // deixaria de sincronizar em silêncio — o pior modo de falha possível aqui.
    for (const bad of [0, -4, 0.5, Number.NaN]) {
      expect(
        isIngestHour({
          intervalHours: bad,
          now: atSaoPauloHour(7),
          timeZone: SP,
        }),
      ).toBe(true);
    }
  });
});
