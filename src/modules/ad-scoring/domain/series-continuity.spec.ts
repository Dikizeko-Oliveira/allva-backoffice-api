import {
  DEFAULT_PAUSE_GAP_DAYS,
  comparableWindow,
  detectResumedAfterPause,
  hasDiscontinuityBetween,
  markResumedAfterPause,
} from './series-continuity';
import type { AdMetricSnapshotRow } from 'src/modules/ads/domain/ports/ad-metrics.repository';

/**
 * §12.5 — **delta, tendência e alerta não atravessam uma descontinuidade.**
 *
 * O gate de A2-S4 que este arquivo sustenta é "nenhum alerta de queda gerado
 * sobre descontinuidade de série". O modo de falha que ele impede é específico e
 * já aconteceu em produtos parecidos: no dia em que um sinal novo passa a ser
 * coletado, todo anúncio ativo muda de score ao mesmo tempo, e o produto dispara
 * uma enxurrada de alertas sobre um fato que é do deploy, não da mídia.
 */

function day(offset: number): Date {
  const date = new Date('2026-07-01T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + offset);
  return date;
}

function point(offset: number, reason: string | null = null) {
  return { date: day(offset), seriesDiscontinuity: reason };
}

describe('janela comparável', () => {
  it('série sem marca é comparável inteira', () => {
    const series = [point(0), point(1), point(2)];

    expect(comparableWindow(series)).toEqual({
      points: series,
      cutBy: null,
      droppedBefore: 0,
    });
  });

  it('corta no ponto marcado, e o ponto marcado ENTRA na janela', () => {
    // Ele é o primeiro sob a régua nova. Excluí-lo jogaria fora o primeiro dia
    // da medição nova sem ganho nenhum.
    const series = [point(0), point(1), point(2, 'NEW_SIGNAL'), point(3)];

    const window = comparableWindow(series);

    expect(window.points).toHaveLength(2);
    expect(window.points[0].date).toEqual(day(2));
    expect(window.cutBy).toBe('NEW_SIGNAL');
    expect(window.droppedBefore).toBe(2);
  });

  it('com duas marcas, vale a MAIS RECENTE', () => {
    // A régua mudou duas vezes; só a última define o que é comparável hoje.
    const series = [
      point(0),
      point(1, 'CURRENCY_REBASED'),
      point(2),
      point(3, 'ALGO_VERSION_CHANGED'),
      point(4),
    ];

    const window = comparableWindow(series);

    expect(window.cutBy).toBe('ALGO_VERSION_CHANGED');
    expect(window.points).toHaveLength(2);
  });

  it('marca no primeiro ponto não descarta nada, mas é declarada', () => {
    const window = comparableWindow([point(0, 'NEW_SIGNAL'), point(1)]);

    expect(window.droppedBefore).toBe(0);
    expect(window.points).toHaveLength(2);
    // O motivo continua visível: quem exibe precisa dizer que a série começa ali
    // por decisão, não por falta de dado anterior.
    expect(window.cutBy).toBe('NEW_SIGNAL');
  });

  it('motivo fora do vocabulário não corta a série', () => {
    const window = comparableWindow([point(0), point(1, 'QUEBROU'), point(2)]);

    expect(window.cutBy).toBeNull();
    expect(window.points).toHaveLength(3);
  });

  it('série vazia não quebra', () => {
    expect(comparableWindow([])).toEqual({
      points: [],
      cutBy: null,
      droppedBefore: 0,
    });
  });
});

describe('a comparação entre dois instantes', () => {
  const series = [point(0), point(3, 'NEW_SIGNAL'), point(6)];

  it('recusa comparar através da marca — é o gate do alerta de queda', () => {
    expect(hasDiscontinuityBetween(series, day(0), day(6))).toBe(true);
  });

  it('permite comparar dentro do mesmo trecho', () => {
    expect(hasDiscontinuityBetween([point(3), point(6)], day(3), day(6))).toBe(
      false,
    );
  });

  it('não depende da ordem dos argumentos', () => {
    expect(hasDiscontinuityBetween(series, day(6), day(0))).toBe(true);
  });

  it('o ponto marcado corta o que é anterior a ele, não o que vem depois', () => {
    // `from` exclusivo, `to` inclusivo: comparar D+3 com D+6 é comparar dois
    // pontos sob a mesma régua, porque a marca está em D+3.
    expect(hasDiscontinuityBetween(series, day(3), day(6))).toBe(false);
    expect(hasDiscontinuityBetween(series, day(2), day(6))).toBe(true);
  });
});

describe('retomada após pausa — a única causa derivável da série', () => {
  function delivering(offsets: number[]) {
    return offsets.map((offset) => ({ date: day(offset), impressions: 1000 }));
  }

  it('marca o dia do RETORNO, não o último antes da pausa', () => {
    // É o retorno que é o primeiro sob a régua nova: a plataforma reinicia o
    // aprendizado, e a série de antes descreve outra entrega.
    const marks = detectResumedAfterPause({
      series: delivering([0, 1, 2, 20, 21]),
    });

    expect(marks).toEqual([day(20)]);
  });

  it('oscilação normal de entrega não é descontinuidade', () => {
    // Marcar a cada dois dias sem entrega cortaria a série de anúncios saudáveis
    // toda semana — e uma descontinuidade que acontece o tempo todo não informa.
    expect(
      detectResumedAfterPause({ series: delivering([0, 1, 4, 5]) }),
    ).toEqual([]);
    expect(DEFAULT_PAUSE_GAP_DAYS).toBe(7);
  });

  it('dias sem impressão contam como pausa, mesmo presentes na série', () => {
    const series = [
      { date: day(0), impressions: 1000 },
      ...Array.from({ length: 10 }, (_, index) => ({
        date: day(index + 1),
        impressions: 0,
      })),
      { date: day(11), impressions: 1000 },
    ];

    expect(detectResumedAfterPause({ series })).toEqual([day(11)]);
  });

  it('detecta mais de uma retomada', () => {
    expect(
      detectResumedAfterPause({ series: delivering([0, 10, 30]) }),
    ).toEqual([day(10), day(30)]);
  });

  it('respeita um limiar informado', () => {
    expect(
      detectResumedAfterPause({ series: delivering([0, 3]), gapDays: 2 }),
    ).toEqual([day(3)]);
  });
});

describe('aplicação das marcas na série', () => {
  function row(offset: number, overrides: Partial<AdMetricSnapshotRow> = {}) {
    return {
      date: day(offset),
      impressions: 1000,
      seriesDiscontinuity: null,
      ...overrides,
    } as AdMetricSnapshotRow;
  }

  it('marca a retomada sem tocar no resto', () => {
    const marked = markResumedAfterPause([row(0), row(1), row(20)]);

    expect(marked.map((r) => r.seriesDiscontinuity)).toEqual([
      null,
      null,
      'RESUMED_AFTER_PAUSE',
    ]);
  });

  it('não sobrescreve um motivo já declarado', () => {
    // `CURRENCY_REBASED` é um fato que alguém registrou; deduzir uma pausa por
    // cima apagaria a causa real com a que o sistema conseguiu inferir.
    const marked = markResumedAfterPause([
      row(0),
      row(20, { seriesDiscontinuity: 'CURRENCY_REBASED' }),
    ]);

    expect(marked[1].seriesDiscontinuity).toBe('CURRENCY_REBASED');
  });

  it('série sem pausa volta idêntica, sem cópia desnecessária', () => {
    const series = [row(0), row(1)];

    expect(markResumedAfterPause(series)).toBe(series);
  });
});
