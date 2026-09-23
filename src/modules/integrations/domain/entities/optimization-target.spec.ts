import {
  benchmarkSegmentOf,
  conversionTarget,
  describeOptimization,
  judgesConversion,
  nonConversionTarget,
  resolveAdOptimization,
  toOptimizationTarget,
  UNKNOWN_OPTIMIZATION,
} from './optimization-target';

describe('optimization-target', () => {
  describe('judgesConversion', () => {
    it('julga só conversão contável', () => {
      expect(judgesConversion(conversionTarget('LEAD'))).toBe(true);
      expect(judgesConversion(conversionTarget('OTHER', false))).toBe(false);
    });

    it.each(['TRAFFIC', 'AWARENESS', 'ENGAGEMENT'] as const)(
      '%s nunca é julgado por conversão',
      (cls) => {
        expect(judgesConversion(nonConversionTarget(cls))).toBe(false);
      },
    );

    it('objetivo desconhecido não é julgado — a resposta segura é não cobrar', () => {
      expect(judgesConversion(UNKNOWN_OPTIMIZATION)).toBe(false);
    });
  });

  describe('resolveAdOptimization', () => {
    it('o conjunto vence a campanha', () => {
      const resolved = resolveAdOptimization(
        conversionTarget('LEAD'),
        conversionTarget('PURCHASE'),
      );
      expect(resolved.conversionEvent).toBe('LEAD');
      expect(resolved.source).toBe('AD_SET');
    });

    it('conjunto sem meta (UNKNOWN) cai para a campanha', () => {
      const resolved = resolveAdOptimization(
        UNKNOWN_OPTIMIZATION,
        nonConversionTarget('AWARENESS'),
      );
      expect(resolved.optimizationClass).toBe('AWARENESS');
      expect(resolved.source).toBe('CAMPAIGN');
    });

    it('sem nada declarado, UNKNOWN com origem NONE', () => {
      const resolved = resolveAdOptimization(null, null);
      expect(resolved.optimizationClass).toBe('UNKNOWN');
      expect(resolved.source).toBe('NONE');
    });
  });

  describe('toOptimizationTarget', () => {
    it('coluna nula é "ainda não lido"', () => {
      expect(
        toOptimizationTarget({
          optimizationClass: null,
          conversionEvent: null,
          conversionMeasurable: false,
        }),
      ).toBeNull();
    });

    it('conversão sem evento conhecido não é contável, mesmo com a flag ligada', () => {
      const target = toOptimizationTarget({
        optimizationClass: 'CONVERSION',
        conversionEvent: 'EVENTO_QUE_NAO_EXISTE',
        conversionMeasurable: true,
      });
      expect(target).toEqual({
        optimizationClass: 'CONVERSION',
        conversionEvent: null,
        conversionMeasurable: false,
      });
    });

    it('fora de conversão, evento e flag são descartados', () => {
      expect(
        toOptimizationTarget({
          optimizationClass: 'TRAFFIC',
          conversionEvent: 'PURCHASE',
          conversionMeasurable: true,
        }),
      ).toEqual(nonConversionTarget('TRAFFIC'));
    });
  });

  describe('benchmarkSegmentOf', () => {
    it('separa conversão por evento e os demais por classe', () => {
      expect(benchmarkSegmentOf(conversionTarget('LEAD'))).toBe(
        'CONVERSION:LEAD',
      );
      expect(benchmarkSegmentOf(conversionTarget('PURCHASE'))).not.toBe(
        benchmarkSegmentOf(conversionTarget('LEAD')),
      );
      expect(benchmarkSegmentOf(nonConversionTarget('AWARENESS'))).toBe(
        'AWARENESS',
      );
    });
  });

  it('descreve em português para a tela', () => {
    expect(describeOptimization(conversionTarget('LEAD'))).toBe(
      'conversão (lead)',
    );
    expect(describeOptimization(nonConversionTarget('TRAFFIC'))).toBe(
      'tráfego',
    );
  });
});
