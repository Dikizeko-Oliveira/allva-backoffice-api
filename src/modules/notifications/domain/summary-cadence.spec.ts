import { shouldSendSummaryToday } from './summary-cadence';

const SP = 'America/Sao_Paulo';

/** O instante em que o cron dispara: 08:00 em São Paulo (11:00 UTC). */
function cronFires(isoDate: string): Date {
  return new Date(`${isoDate}T11:00:00.000Z`);
}

describe('quando o resumo sai', () => {
  // 2026-08-17 é uma segunda; 2026-08-18 é terça.
  const segunda = cronFires('2026-08-17');
  const terca = cronFires('2026-08-18');

  it('diário sai todo dia', () => {
    for (const now of [segunda, terca]) {
      expect(
        shouldSendSummaryToday({ cadence: 'DAILY', now, timeZone: SP }),
      ).toBe(true);
    }
  });

  it('semanal sai só na segunda', () => {
    expect(
      shouldSendSummaryToday({ cadence: 'WEEKLY', now: segunda, timeZone: SP }),
    ).toBe(true);
    expect(
      shouldSendSummaryToday({ cadence: 'WEEKLY', now: terca, timeZone: SP }),
    ).toBe(false);
  });

  it('lê o dia no fuso do agendamento, não no do processo', () => {
    /**
     * O defeito silencioso que o parâmetro impede: às 11:00 UTC de segunda, um
     * servidor em UTC−12 ainda está no domingo. O resumo semanal simplesmente
     * nunca sairia — nunca seria segunda para ele —, e o sintoma apareceria
     * meses depois como "o Individual parou de receber email", sem nada nos logs.
     */
    expect(
      shouldSendSummaryToday({
        cadence: 'WEEKLY',
        now: segunda,
        timeZone: 'Etc/GMT+12',
      }),
    ).toBe(false);

    expect(
      shouldSendSummaryToday({ cadence: 'WEEKLY', now: segunda, timeZone: SP }),
    ).toBe(true);
  });
});
