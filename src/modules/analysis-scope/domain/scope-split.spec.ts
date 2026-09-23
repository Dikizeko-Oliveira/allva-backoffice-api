import {
  CORE_HYSTERESIS,
  MIN_LIMIT_FOR_ROTATION,
  ROTATION_SHARE,
  rotationCycleNights,
  splitScope,
} from './scope-split';

/**
 * A divisão do teto entre núcleo e rodízio.
 *
 * O que ela corrige: a régua escolhia os N que mais gastam **toda noite**, e o
 * ranking de gasto é estável — então os mesmos anúncios eram olhados para
 * sempre. Um cliente com 5.000 anúncios no plano de 300 tinha 4.700 que a Allva
 * nunca analisou.
 */
describe('splitScope', () => {
  it('mantém o teto do plano intacto: núcleo + rodízio = teto', () => {
    // A correção não compra cobertura com cota. São 300 por noite, nem mais nem
    // menos — o que muda é que os 300 deixam de ser sempre os mesmos.
    for (const limit of [20, 100, 300, 2_000, 5_000]) {
      const split = splitScope(limit)!;

      expect(split.core + split.rotation).toBe(limit);
    }
  });

  it('reserva um quinto para a cauda', () => {
    const split = splitScope(300)!;

    expect(split.rotation).toBe(300 * ROTATION_SHARE);
    expect(split.core).toBe(240);
  });

  it('o resto do arredondamento fica com o núcleo', () => {
    // Vaga a mais no núcleo é análise garantida; vaga a mais no rodízio é uma
    // volta a menos na cauda. O resto cai para o lado certo.
    const split = splitScope(101)!;

    expect(split.rotation).toBe(20);
    expect(split.core).toBe(81);
  });

  it('abaixo do piso não divide: teto pequeno vira núcleo inteiro', () => {
    // Um rodízio de uma vaga leva a cauda uma noite por anúncio e o núcleo
    // perde o anúncio que de fato queima dinheiro. Trocar cobertura por
    // instabilidade sem ganhar nada é pior que o comportamento antigo.
    const split = splitScope(MIN_LIMIT_FOR_ROTATION - 1)!;

    expect(split.rotation).toBe(0);
    expect(split.core).toBe(MIN_LIMIT_FOR_ROTATION - 1);
  });

  it('sem teto não há o que dividir', () => {
    expect(splitScope(null)).toBeNull();
  });

  it('teto zero não concede vaga nenhuma', () => {
    expect(splitScope(0)).toEqual({ core: 0, rotation: 0, coreHighWater: 0 });
  });

  it('a histerese dá folga ao incumbente, sem dobrar o núcleo', () => {
    const split = splitScope(300)!;

    expect(split.coreHighWater).toBe(Math.floor(240 * CORE_HYSTERESIS));
    expect(split.coreHighWater).toBeGreaterThan(split.core);
    // Folga, não segunda vaga: quem despencou de verdade sai.
    expect(split.coreHighWater).toBeLessThan(split.core * 2);
  });
});

describe('rotationCycleNights', () => {
  /**
   * O número que torna a promessa verificável.
   *
   * Sem ele o produto diria "todos os anúncios são analisados" e deixaria o
   * cliente descobrir a cadência sozinho. Com ele, "seus 5.000 giram em 80
   * noites no Individual e em 9 no Profissional" é o argumento de upgrade mais
   * honesto que o packaging tem.
   */
  it('900 anúncios no Individual: a cauda gira em 11 noites', () => {
    // Teto 300 → núcleo 240 + rodízio 60. Cauda = 900 - 240 = 660.
    expect(rotationCycleNights(splitScope(300), 660)).toBe(11);
  });

  it('5.000 no Individual contra 5.000 no Profissional', () => {
    // É a diferença que o upgrade compra, em números que dá para publicar.
    expect(rotationCycleNights(splitScope(300), 4_760)).toBe(80);
    expect(rotationCycleNights(splitScope(2_000), 3_400)).toBe(9);
  });

  it('sem cauda não há ciclo a descrever', () => {
    expect(rotationCycleNights(splitScope(300), 0)).toBeNull();
  });

  it('sem rodízio não há ciclo — teto pequeno ou ilimitado', () => {
    expect(rotationCycleNights(splitScope(10), 500)).toBeNull();
    expect(rotationCycleNights(null, 500)).toBeNull();
  });
});
