import { redistributeRevenue } from './revenue-redistribution';

describe('redistributeRevenue', () => {
  const platforms = {
    META: { spend: 600, revenue: 1200 },
    GOOGLE: { spend: 400, revenue: 1800 },
  };
  const totalRevenue = 3000;

  const sum = (values: Record<string, number>) =>
    Object.values(values).reduce((acc, value) => acc + value, 0);

  it('last-click devolve a receita como cada plataforma reporta', () => {
    expect(redistributeRevenue(platforms, 'last-click')).toEqual({
      META: 1200,
      GOOGLE: 1800,
    });
  });

  it('linear divide o total pela fatia de investimento', () => {
    const out = redistributeRevenue(platforms, 'linear');
    expect(out.META).toBeCloseTo(1800); // 60% de 3000
    expect(out.GOOGLE).toBeCloseTo(1200); // 40% de 3000
  });

  it('blended-attribution mistura metade reportada e metade por investimento', () => {
    const out = redistributeRevenue(platforms, 'blended-attribution');
    expect(out.META).toBeCloseTo(0.5 * 1200 + 0.5 * 1800);
    expect(out.GOOGLE).toBeCloseTo(0.5 * 1800 + 0.5 * 1200);
  });

  it('as três opções dão números diferentes quando reportado e investimento divergem', () => {
    const lastClick = redistributeRevenue(platforms, 'last-click').META;
    const linear = redistributeRevenue(platforms, 'linear').META;
    const blended = redistributeRevenue(platforms, 'blended-attribution').META;
    expect(new Set([lastClick, linear, blended]).size).toBe(3);
  });

  it.each(['last-click', 'linear', 'blended-attribution'] as const)(
    '%s preserva a receita total observada',
    (model) => {
      expect(sum(redistributeRevenue(platforms, model))).toBeCloseTo(
        totalRevenue,
      );
    },
  );

  it('sem investimento, mantém a receita reportada em vez de dividir por zero', () => {
    const idle = {
      META: { spend: 0, revenue: 50 },
      TIKTOK: { spend: 0, revenue: 0 },
    };
    expect(redistributeRevenue(idle, 'linear')).toEqual({
      META: 50,
      TIKTOK: 0,
    });
  });

  it('sem plataformas, devolve vazio', () => {
    expect(redistributeRevenue({}, 'blended-attribution')).toEqual({});
  });
});
