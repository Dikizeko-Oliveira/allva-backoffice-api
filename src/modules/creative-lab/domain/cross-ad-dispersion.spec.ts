import {
  HIGH_DISPERSION_THRESHOLD,
  MIN_ADS_FOR_VERDICT,
  type ComparableAd,
  compareAdsOfCreative,
  dispersionOf,
} from './cross-ad-dispersion';
import {
  MIN_CANDIDATE_SCORE,
  RECENT_RUN_COOLDOWN_DAYS,
  resolveCandidates,
} from './creative-candidates';

/**
 * §11.3 e §11.4 — comparação entre anúncios do mesmo criativo e candidatos de
 * substituição.
 *
 * As regras da tabela de §11.3 existem cada uma contra um jeito específico de
 * errar, e os testes nomeiam esses jeitos.
 */

function ad(overrides: Partial<ComparableAd> = {}): ComparableAd {
  return {
    adId: 'ad-1',
    aiScore: 60,
    aiConfidence: 0.8,
    componentCoverage: 0.8,
    adSetId: 'set-1',
    ...overrides,
  };
}

describe('dispersão (§11.3)', () => {
  it('**nunca é `max − min`** — um outlier não define o diagnóstico', () => {
    // Quatro anúncios juntos e um anômalo. A amplitude diria 50 e descreveria
    // só o anômalo; o IQR descreve os quatro que importam.
    const dispersion = dispersionOf([60, 61, 62, 63, 110]);

    expect(dispersion.measure).toBe('IQR');
    expect(dispersion.value).toBeLessThan(10);
  });

  it('cai para MAD quando a amostra não sustenta quartis', () => {
    const dispersion = dispersionOf([50, 60, 70]);

    expect(dispersion.measure).toBe('MAD');
    expect(dispersion.median).toBe(60);
  });

  it('série idêntica tem dispersão zero', () => {
    expect(dispersionOf([70, 70, 70, 70]).value).toBe(0);
  });
});

describe('comparação entre anúncios do mesmo criativo', () => {
  it('**abaixo de três anúncios não há veredito**, e a comparação é exibida', () => {
    // "Diferença entre dois pontos não é dispersão": com dois, qualquer
    // distância vira 100% do sinal e o veredito descreve o acaso.
    const result = compareAdsOfCreative([
      ad({ adId: 'a' }),
      ad({ adId: 'b', aiScore: 90 }),
    ]);

    expect(MIN_ADS_FOR_VERDICT).toBe(3);
    expect(result.verdict).toBeNull();
    expect(result.compared).toHaveLength(2);
    // A dispersão continua sendo calculada e exibida — o que falta é a conclusão.
    expect(result.dispersion).not.toBeNull();
  });

  it('exclui cobertura incompatível, e **declara a exclusão**', () => {
    // Comparar 5 componentes com 2 produz dispersão artificial: os dois scores
    // são válidos e medem coisas diferentes.
    const result = compareAdsOfCreative([
      ad({ adId: 'a', componentCoverage: 0.8 }),
      ad({ adId: 'b', componentCoverage: 0.8 }),
      ad({ adId: 'c', componentCoverage: 0.8 }),
      ad({ adId: 'incompativel', componentCoverage: 0.2, aiScore: 20 }),
    ]);

    expect(result.compared.map((a) => a.adId)).not.toContain('incompativel');
    expect(result.excluded[0]).toMatchObject({ adId: 'incompativel' });
    expect(result.excluded[0].reason).toContain('cobertura');
  });

  it('exclui quem está abaixo do piso de confiança de §12.4', () => {
    const result = compareAdsOfCreative([
      ad({ adId: 'a' }),
      ad({ adId: 'b' }),
      ad({ adId: 'inseguro', aiConfidence: 0.1 }),
    ]);

    expect(result.excluded[0]).toMatchObject({ adId: 'inseguro' });
    expect(result.excluded[0].reason).toContain('confiança');
  });

  it('dispersão alta entre conjuntos aponta público, com alternativas (P7)', () => {
    const result = compareAdsOfCreative([
      ad({ adId: 'a', aiScore: 30, adSetId: 's1' }),
      ad({ adId: 'b', aiScore: 45, adSetId: 's2' }),
      ad({ adId: 'c', aiScore: 75, adSetId: 's3' }),
      ad({ adId: 'd', aiScore: 85, adSetId: 's4' }),
    ]);

    expect(result.dispersion!.value).toBeGreaterThanOrEqual(
      HIGH_DISPERSION_THRESHOLD,
    );
    expect(result.verdict!.value).toBe('AUDIENCE_MISMATCH');
    // Público é **uma hipótese** entre lance, orçamento e tempo em veiculação:
    // um veredito sem alternativas vira diagnóstico, e o usuário age sobre isso.
    expect(result.verdict!.alternativeExplanations.length).toBeGreaterThan(0);
  });

  it('com um conjunto só, o mesmo padrão vale menos', () => {
    // "Público diferente" perde a explicação mais natural quando todos os
    // anúncios estão no mesmo conjunto — e a confiança cai, em vez de o veredito
    // mudar de nome para algo que não foi medido.
    const varios = compareAdsOfCreative([
      ad({ adId: 'a', aiScore: 30, adSetId: 's1' }),
      ad({ adId: 'b', aiScore: 45, adSetId: 's2' }),
      ad({ adId: 'c', aiScore: 75, adSetId: 's3' }),
      ad({ adId: 'd', aiScore: 85, adSetId: 's4' }),
    ]);
    const umSo = compareAdsOfCreative([
      ad({ adId: 'a', aiScore: 30, adSetId: 's1' }),
      ad({ adId: 'b', aiScore: 45, adSetId: 's1' }),
      ad({ adId: 'c', aiScore: 75, adSetId: 's1' }),
      ad({ adId: 'd', aiScore: 85, adSetId: 's1' }),
    ]);

    expect(umSo.verdict!.confidence).toBeLessThan(varios.verdict!.confidence);
  });

  it('dispersão baixa com score baixo é criativo ruim, não público', () => {
    const result = compareAdsOfCreative([
      ad({ adId: 'a', aiScore: 30 }),
      ad({ adId: 'b', aiScore: 32 }),
      ad({ adId: 'c', aiScore: 31 }),
      ad({ adId: 'd', aiScore: 33 }),
    ]);

    expect(result.verdict!.value).toBe('CREATIVE_UNDERPERFORMS');
  });

  it('o veredito nunca é mais confiante que a evidência', () => {
    const result = compareAdsOfCreative([
      ad({ adId: 'a', aiConfidence: 0.5 }),
      ad({ adId: 'b', aiConfidence: 0.5 }),
      ad({ adId: 'c', aiConfidence: 0.5 }),
    ]);

    expect(result.verdict!.confidence).toBeLessThanOrEqual(0.5);
  });
});

describe('candidatos de substituição (§11.4)', () => {
  const base = {
    creativeId: 'cr-bom',
    contentHash: 'hash-diferente',
    name: 'Criativo bom' as string | null,
    externalCreativeId: 'ext-cr-bom',
    thumbnailUrl: null as string | null,
    averageScore: 80,
    sampleSize: 4,
    ranInAdSetIds: [] as string[],
    lastRanAt: null as Date | null,
  };

  const NOW = new Date('2026-08-01T00:00:00Z');

  it('sem candidato, a recomendação vira CONSULTIVA', () => {
    // Uma recomendação com ação impossível é pior que uma sem ação: o usuário
    // clica, recebe erro, e perde a confiança no resto da tela.
    const result = resolveCandidates({
      fatiguedContentHash: 'hash-cansado',
      targetAdSetId: 'set-1',
      candidates: [],
      now: NOW,
    });

    expect(result.kind).toBe('ADVISORY');
  });

  it('recusa candidato com o MESMO conteúdo', () => {
    // Trocar um criativo cansado por outro idêntico resolve o registro, não o
    // problema — o público vê a mesma coisa.
    const result = resolveCandidates({
      fatiguedContentHash: 'hash-cansado',
      targetAdSetId: 'set-1',
      candidates: [{ ...base, contentHash: 'hash-cansado' }],
      now: NOW,
    });

    expect(result.kind).toBe('ADVISORY');
  });

  it('recusa candidato pior que o piso', () => {
    expect(
      resolveCandidates({
        fatiguedContentHash: 'hash-cansado',
        targetAdSetId: 'set-1',
        candidates: [{ ...base, averageScore: MIN_CANDIDATE_SCORE - 1 }],
        now: NOW,
      }).kind,
    ).toBe('ADVISORY');
  });

  it('recusa quem já rodou neste conjunto há pouco', () => {
    const recente = new Date(NOW);
    recente.setUTCDate(recente.getUTCDate() - (RECENT_RUN_COOLDOWN_DAYS - 5));

    expect(
      resolveCandidates({
        fatiguedContentHash: 'hash-cansado',
        targetAdSetId: 'set-1',
        candidates: [{ ...base, ranInAdSetIds: ['set-1'], lastRanAt: recente }],
        now: NOW,
      }).kind,
    ).toBe('ADVISORY');
  });

  it('aceita quem rodou no conjunto há tempo suficiente', () => {
    const antigo = new Date(NOW);
    antigo.setUTCDate(antigo.getUTCDate() - (RECENT_RUN_COOLDOWN_DAYS + 5));

    expect(
      resolveCandidates({
        fatiguedContentHash: 'hash-cansado',
        targetAdSetId: 'set-1',
        candidates: [{ ...base, ranInAdSetIds: ['set-1'], lastRanAt: antigo }],
        now: NOW,
      }).kind,
    ).toBe('CANDIDATES');
  });

  it('ranqueia por desempenho e devolve justificativa por candidato', () => {
    const result = resolveCandidates({
      fatiguedContentHash: 'hash-cansado',
      targetAdSetId: 'set-1',
      candidates: [
        { ...base, creativeId: 'medio', averageScore: 60 },
        { ...base, creativeId: 'otimo', averageScore: 92 },
      ],
      now: NOW,
    });

    expect(result.kind).toBe('CANDIDATES');
    if (result.kind !== 'CANDIDATES') return;

    expect(result.candidates[0].creativeId).toBe('otimo');
    expect(result.candidates[0].rationale).toContain('score médio');
  });
});
