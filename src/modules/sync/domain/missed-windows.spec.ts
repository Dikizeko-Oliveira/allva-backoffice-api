import { expectedWindows, gapFor } from './missed-windows';

/**
 * A pergunta que ninguém fazia: quantas janelas deveriam ter existido?
 *
 * O cenário destes testes é literal — o cron horário de staging executou 8 vezes
 * em 24 horas, todas `SUCCEEDED`, e nada em lugar nenhum apontava as 16 que
 * faltaram. Cada leitura isolada dos logs mostrava sucesso.
 */

const NOW = new Date('2026-09-07T14:30:00.000Z');

function hoursBefore(hours: number): Date {
  return new Date(NOW.getTime() - hours * 60 * 60_000);
}

describe('janelas esperadas', () => {
  it('enumera uma janela por hora, sem repetir', () => {
    const keys = expectedWindows('HOURLY', hoursBefore(5), NOW);

    expect(keys).toEqual([
      '2026-09-07T09',
      '2026-09-07T10',
      '2026-09-07T11',
      '2026-09-07T12',
      '2026-09-07T13',
    ]);
  });

  it('não cobra a janela em curso', () => {
    const keys = expectedWindows('HOURLY', hoursBefore(3), NOW);

    // A das 14h ainda pode ser preenchida; cobrá-la faria a auditoria gritar a
    // cada passagem, e rede de segurança que grita sempre deixa de ser lida.
    expect(keys).not.toContain('2026-09-07T14');
  });

  it('a diária enumera dias', () => {
    const keys = expectedWindows('DAILY', hoursBefore(24 * 3), NOW);

    expect(keys).toEqual(['2026-09-04', '2026-09-05', '2026-09-06']);
  });

  it('mensal fica de fora — grossa demais para dizer algo útil', () => {
    expect(expectedWindows('MONTHLY', hoursBefore(24 * 60), NOW)).toEqual([]);
  });
});

describe('janelas perdidas', () => {
  it('reconhece o cron horário que só executou 8 vezes em 24 horas', () => {
    const expected = expectedWindows('HOURLY', hoursBefore(24), NOW);
    // As horas em que o container estava de pé, no formato real do banco.
    const recorded = [
      '2026-09-07T02',
      '2026-09-07T03',
      '2026-09-07T06',
      '2026-09-07T09',
      '2026-09-06T17',
      '2026-09-06T18',
      '2026-09-06T19',
      '2026-09-06T22',
    ];

    const gap = gapFor({ jobName: 'ads-ingest', expected, recorded });

    expect(gap).not.toBeNull();
    expect(gap!.expected).toBe(24);
    expect(gap!.missing).toBe(16);
  });

  it('silêncio total aparece como janela perdida, não como ausência de dado', () => {
    const expected = expectedWindows('DAILY', hoursBefore(24 * 7), NOW);

    const gap = gapFor({ jobName: 'ads-ingest-full', expected, recorded: [] });

    // O caso do `ads-ingest-full`, que nunca registrou uma única linha: sem esta
    // comparação ele é indistinguível de um job que não existe.
    expect(gap!.missing).toBe(gap!.expected);
  });

  it('nomeia as perdas mais recentes — a pergunta é desde quando parou', () => {
    const expected = expectedWindows('HOURLY', hoursBefore(10), NOW);

    const gap = gapFor({ jobName: 'ads-ingest', expected, recorded: [] });

    expect(gap!.mostRecentMissing).toEqual([
      '2026-09-07T09',
      '2026-09-07T10',
      '2026-09-07T11',
      '2026-09-07T12',
      '2026-09-07T13',
    ]);
  });

  it('janela decidida não é janela perdida', () => {
    const expected = expectedWindows('HOURLY', hoursBefore(3), NOW);

    // `SKIPPED` e `FAILED` também deixam linha: o sistema olhou e decidiu, e
    // isso é informação. O detector procura a ausência de decisão.
    const gap = gapFor({
      jobName: 'ads-ingest',
      expected,
      recorded: expected,
    });

    expect(gap).toBeNull();
  });
});
