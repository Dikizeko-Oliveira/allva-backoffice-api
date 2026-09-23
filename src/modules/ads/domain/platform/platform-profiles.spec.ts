import {
  PLATFORM_PROFILES,
  platformCoverageMax,
  toCanonicalStatus,
} from './platform-profiles';

describe('PlatformProfile', () => {
  it('perfila as três plataformas suportadas', () => {
    expect(Object.keys(PLATFORM_PROFILES).sort()).toEqual([
      'GOOGLE',
      'META',
      'TIKTOK',
    ]);
  });

  it('declara o motivo de cada métrica indisponível (P7)', () => {
    // Um campo listado como indisponível sem motivo seria pior que ausente: a
    // tela mostraria confiança reduzida sem conseguir explicar por quê.
    for (const profile of Object.values(PLATFORM_PROFILES)) {
      for (const [field, reason] of Object.entries(
        profile.metrics.unavailable,
      )) {
        expect(typeof reason).toBe('string');
        expect(reason.length).toBeGreaterThan(10);
        expect(profile.metrics.available).not.toContain(field);
      }
    }
  });

  it('mapeia status cru para canônico por plataforma', () => {
    expect(toCanonicalStatus('META', 'ACTIVE')).toBe('ACTIVE');
    expect(toCanonicalStatus('GOOGLE', 'ENABLED')).toBe('ACTIVE');
    expect(toCanonicalStatus('TIKTOK', 'ENABLE')).toBe('ACTIVE');
    expect(toCanonicalStatus('GOOGLE', 'REMOVED')).toBe('DELETED');
    expect(toCanonicalStatus('TIKTOK', 'AUDIT_DENY')).toBe('DISAPPROVED');
  });

  /**
   * A v1.3 do TikTok entrega `secondary_status`, e é ele que o sync grava. Sem
   * estas chaves todo anúncio do TikTok virava `UNKNOWN`.
   */
  it('mapeia o status de entrega do TikTok', () => {
    expect(toCanonicalStatus('TIKTOK', 'AD_STATUS_DELIVERY_OK')).toBe('ACTIVE');
    expect(toCanonicalStatus('TIKTOK', 'AD_STATUS_CAMPAIGN_DISABLE')).toBe(
      'PAUSED',
    );
    expect(toCanonicalStatus('TIKTOK', 'AD_STATUS_AUDIT_DENY')).toBe(
      'DISAPPROVED',
    );
    expect(toCanonicalStatus('TIKTOK', 'ADGROUP_STATUS_DELETE')).toBe(
      'DELETED',
    );
    // Orçamento do dia esgotado volta sozinho: não é pausa.
    expect(toCanonicalStatus('TIKTOK', 'AD_STATUS_BUDGET_EXCEED')).toBe(
      'ACTIVE',
    );
  });

  it('mapeia os status que o Google só expõe compostos', () => {
    expect(toCanonicalStatus('GOOGLE', 'DISAPPROVED')).toBe('DISAPPROVED');
    expect(toCanonicalStatus('GOOGLE', 'PENDING_REVIEW')).toBe(
      'PENDING_REVIEW',
    );
  });

  /**
   * O `previousState` do enfileiramento guarda o status canônico, e a reversão
   * o relê por aqui. No Google e no TikTok `ACTIVE` não é status cru: virava
   * `UNKNOWN`, e reverter uma pausa era recusado só nessas duas plataformas.
   */
  it('aceita status que já é canônico, em qualquer plataforma', () => {
    expect(toCanonicalStatus('GOOGLE', 'ACTIVE')).toBe('ACTIVE');
    expect(toCanonicalStatus('TIKTOK', 'ACTIVE')).toBe('ACTIVE');
    expect(toCanonicalStatus('TIKTOK', 'PAUSED')).toBe('PAUSED');
  });

  it('trata status desconhecido como UNKNOWN, nunca como ACTIVE', () => {
    // Assumir veiculação para um estado não mapeado faria o produto recomendar
    // pausar um anúncio que a plataforma já havia reprovado.
    expect(toCanonicalStatus('META', 'SOMETHING_NEW')).toBe('UNKNOWN');
  });

  it('declara REMOVED do Google como irreversível', () => {
    expect(PLATFORM_PROFILES.GOOGLE.status.irreversible).toContain('DELETED');
  });

  it('declara onde o orçamento pode ser alterado em cada plataforma', () => {
    // Google só tem orçamento na campanha: uma recomendação de ajuste em grupo
    // de anúncios é irrealizável lá, e §9.2 replaneja antes de descartar.
    expect(PLATFORM_PROFILES.GOOGLE.hierarchy.budgetLevels).toEqual([
      'CAMPAIGN',
    ]);
    expect(PLATFORM_PROFILES.META.hierarchy.budgetLevels).toContain('AD_SET');
  });
});

describe('platformCoverageMax (D11)', () => {
  // Os pesos do composto de §12.1 que dependem de sinal de plataforma.
  const WEIGHTS = {
    thumbstopRate: 0.25,
    hides: 0.15,
    frequency: 0.15,
    clicks: 0.25,
    conversions: 0.2,
  } as const;

  it('é 1 para uma plataforma que entrega todos os sinais', () => {
    expect(platformCoverageMax('META', WEIGHTS)).toBeCloseTo(1, 10);
  });

  it('é menor que 1 no Google, que não expõe frequência nem feedback', () => {
    const google = platformCoverageMax('GOOGLE', WEIGHTS);

    // thumbstopRate (0,25) conta a favor do Google desde que o provider passou
    // a ler o quartil de visualização de vídeo: 0,25 + 0,25 (clicks) + 0,2
    // (conversions) = 0,7. hides e frequency continuam de fora.
    expect(google).toBeCloseTo(0.7, 10);
    expect(google).toBeLessThan(1);
  });
});
