import {
  RETENTION_DAYS,
  RETENTION_EXEMPT,
  RETENTION_RULES,
  droppablePartitions,
  keepDaysFor,
  retentionCutoff,
} from './retention-policy';

/**
 * §14.6 — **a única política do sistema cujo efeito não tem desfazer.**
 *
 * `DROP PARTITION` remove os arquivos. Um erro de fronteira aqui não aparece em
 * lugar nenhum até alguém procurar um mês que já não existe — e aí não há
 * correção possível, só uma explicação.
 */

describe('a fronteira da poda de partições', () => {
  const cutoff = new Date(Date.UTC(2026, 6, 1)); // 2026-07-01

  it('dropa só os meses que terminam ANTES do corte', () => {
    const droppable = droppablePartitions({
      existing: [
        'ad_metric_snapshots_2026_05',
        'ad_metric_snapshots_2026_06',
        'ad_metric_snapshots_2026_07',
        'ad_metric_snapshots_2026_08',
      ],
      cutoff,
    });

    expect(droppable).toEqual([
      'ad_metric_snapshots_2026_05',
      'ad_metric_snapshots_2026_06',
    ]);
  });

  /**
   * O erro que este teste existe para impedir: a partição que **contém** o dia
   * do corte guarda dados dentro da janela de retenção. Dropá-la apagaria o que
   * o produto promete manter — o oposto silencioso do problema que a retenção
   * resolve.
   */
  it('a partição que contém o corte NÃO é dropável', () => {
    const meio = new Date(Date.UTC(2026, 6, 15));

    expect(
      droppablePartitions({
        existing: ['ad_metric_snapshots_2026_07'],
        cutoff: meio,
      }),
    ).toEqual([]);
  });

  it('a partição DEFAULT e nomes fora do formato são ignorados', () => {
    // A `DEFAULT` é a rede de segurança de G4: um ingest sem partição de
    // destino cai nela em vez de falhar por inteiro.
    expect(
      droppablePartitions({
        existing: [
          'ad_metric_snapshots_default',
          'ad_metric_snapshots_2026_13',
          'alguma_outra_tabela_2020_01',
          'ad_metric_snapshots_2020_01',
        ],
        cutoff,
      }),
    ).toEqual(['ad_metric_snapshots_2020_01']);
  });
});

describe('o corte', () => {
  it('são 13 meses, e o corte cai no início do dia UTC', () => {
    const cutoff = retentionCutoff(
      new Date('2026-08-03T18:42:11.123Z'),
      RETENTION_DAYS,
    );

    expect(cutoff.toISOString()).toBe('2025-07-09T00:00:00.000Z');
  });
});

describe('o que a política NÃO poda', () => {
  /**
   * A ausência é a decisão. `action_executions` é trilha de auditoria de escrita
   * em mídia paga (P5): "quem mandou pausar este anúncio?" não tem prazo de
   * validade. `recommendation_outcomes` é o dataset de P8 e o insumo de §20-H3,
   * que mede acurácia ao longo de 90 dias.
   */
  it('a trilha de escrita e o dataset de acurácia estão isentos', () => {
    expect(RETENTION_EXEMPT).toContain('action_executions');
    expect(RETENTION_EXEMPT).toContain('recommendation_outcomes');
    expect(RETENTION_EXEMPT).toContain('audit_logs');
  });

  it('nenhuma tabela isenta aparece nas regras de poda', () => {
    const podadas = RETENTION_RULES.map((rule) => rule.table);

    for (const isenta of RETENTION_EXEMPT) {
      expect(podadas).not.toContain(isenta);
    }
  });

  it('toda regra declara a estratégia e o motivo', () => {
    // Um número solto num SQL não diz por que 13 meses e não 24. O motivo é o
    // que impede o próximo ajuste de ser feito sem entender o anterior.
    for (const rule of RETENTION_RULES) {
      expect(rule.reason.length).toBeGreaterThan(40);
      expect(rule.keepDays).toBeGreaterThan(0);
    }
  });
});

describe('o prazo vem da tabela de regras, e só dela', () => {
  it('resolve o prazo declarado para cada tabela podada', () => {
    // A primeira redação do serviço lia constantes paralelas, e a tabela — que
    // declara `keepDays` **com o motivo** — ficava decorativa. Duas fontes de
    // verdade para o mesmo número divergem no primeiro ajuste, e a que erra é a
    // que ninguém lê.
    expect(keepDaysFor('ad_metric_snapshots')).toBe(RETENTION_DAYS);
    expect(keepDaysFor('ad_scores')).toBe(RETENTION_DAYS);
    expect(keepDaysFor('sync_operations')).toBe(90);
  });

  /**
   * **Lança, e não cai num padrão.** Um `?? 400` silencioso podaria uma tabela
   * nova por um prazo que ninguém escolheu — e num efeito sem desfazer, o
   * silêncio é o pior comportamento possível.
   */
  it('tabela sem regra declarada é erro, não padrão silencioso', () => {
    expect(() => keepDaysFor('ad_scores_v2')).toThrow(/unknown_table/);
  });

  it('nenhuma tabela isenta tem prazo resolvível', () => {
    // Pedir o prazo de `action_executions` é um erro de programa: ela não é
    // podada. Devolver um número aqui seria o primeiro passo para podá-la.
    for (const isenta of RETENTION_EXEMPT) {
      expect(() => keepDaysFor(isenta)).toThrow();
    }
  });
});
