import { assertSelfServePlan } from './assert-self-serve-plan';

/**
 * A regra tem quatro portas, e este teste é o inventário delas.
 *
 * Cada uma chegava sozinha à Stripe — criar assinatura, trocar de plano,
 * checkout hospedado e o downgrade depreciado —, e a quarta estava protegida
 * apenas pela aritmética de `INVALID_DOWNGRADE_TARGET`. Uma quinta porta que
 * esqueça de chamar isto continua sendo possível; o que este arquivo garante é
 * que a resposta seja a mesma nas que existem, e que o predicado não afrouxe
 * sem alguém decidir afrouxar.
 */
describe('assertSelfServePlan', () => {
  it.each(['FREE', 'STARTER', 'PRO'] as const)(
    'deixa passar o plano de autoatendimento %s',
    (type) => {
      expect(() => assertSelfServePlan(type)).not.toThrow();
    },
  );

  it('recusa o Enterprise com o código que a tela sabe tratar', () => {
    expect(() => assertSelfServePlan('ENTERPRISE')).toThrow();

    try {
      assertSelfServePlan('ENTERPRISE');
    } catch (error) {
      // `redirectTo` faz parte do contrato: a recusa tem saída, e é ela que
      // impede a tela de virar um beco depois de pedir o cartão.
      expect((error as { response: unknown }).response).toEqual({
        code: 'PLAN_REQUIRES_SALES_CONTACT',
        message:
          'This plan is negotiated with sales and cannot be contracted directly',
        redirectTo: '/sales',
      });
    }
  });
});
