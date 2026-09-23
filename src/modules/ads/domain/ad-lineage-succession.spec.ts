import { deriveLineage, producesSuccessor, startLineage } from './ad-lineage';

/**
 * §9.5 passo 6 — **suceder não é duplicar**, e a distinção decide quem herda a
 * linhagem. Ela não estava nomeada no plano: A2-S7 declarou "o ad derivado
 * herda `lineageId`" sem separar os dois casos, e aplicá-la a `DUPLICATE_AD`
 * fundiria dois anúncios que competem entre si numa série só.
 */
describe('sucessão contra duplicação', () => {
  /**
   * Sucessão é **por plataforma**: a mesma ação edita em lugar numa e recria na
   * outra. Uma lista global esperaria da Meta um sucessor que ela nunca produz.
   */
  it('segue a estratégia de mutação da plataforma', () => {
    expect(producesSuccessor('META', 'REPLACE_COPY')).toBe(true);
    expect(producesSuccessor('META', 'REPLACE_CREATIVE')).toBe(false);
    expect(producesSuccessor('GOOGLE', 'REPLACE_CREATIVE')).toBe(true);
    expect(producesSuccessor('GOOGLE', 'REPLACE_COPY')).toBe(false);
  });

  /**
   * O original continua veiculando depois de um `DUPLICATE_AD`, e os dois
   * gastam em paralelo. Herdar a linhagem somaria numa série só exatamente o
   * que o produto existe para comparar.
   */
  it('não trata duplicação como sucessão', () => {
    expect(producesSuccessor('META', 'DUPLICATE_AD')).toBe(false);
    expect(producesSuccessor('TIKTOK', 'DUPLICATE_AD')).toBe(false);
  });

  it('não trata mudança de estado nem de orçamento como sucessão', () => {
    expect(producesSuccessor('META', 'PAUSE_AD')).toBe(false);
    expect(producesSuccessor('META', 'ARCHIVE_AD')).toBe(false);
    expect(producesSuccessor('META', 'ADJUST_AD_SET_BUDGET')).toBe(false);
  });
});

describe('herança ao longo de uma cadeia de recriações', () => {
  /**
   * O caso que o campo existe para resolver: sem herdar, o outcome mede o
   * anúncio morto e lê "gasto foi a zero" como sucesso absoluto — quando o gasto
   * só migrou para o sucessor.
   */
  it('herda o lineageId do antecessor, não o id dele', () => {
    const original = startLineage('ad-1');

    const successor = deriveLineage({
      origin: original,
      originAdId: 'ad-1',
      originActionExecutionId: 'exec-1',
    });

    expect(successor.lineageId).toBe('ad-1');
    expect(successor.originAdId).toBe('ad-1');
    expect(successor.originActionExecutionId).toBe('exec-1');
  });

  /**
   * Três trocas de criativo mantêm as três gerações sob a mesma linhagem. Herdar
   * o **id do pai** em vez do `lineageId` partiria a série a cada troca, e a
   * terceira geração não teria como se ligar à primeira.
   */
  it('mantém a série inteira ao longo de três gerações', () => {
    const first = startLineage('ad-1');

    const second = deriveLineage({
      origin: first,
      originAdId: 'ad-1',
      originActionExecutionId: 'exec-1',
    });
    const third = deriveLineage({
      origin: second,
      originAdId: 'ad-2',
      originActionExecutionId: 'exec-2',
    });

    expect(third.lineageId).toBe('ad-1');
    // Cada geração aponta para o pai imediato, não para a raiz: é o que permite
    // reconstruir a ordem, e não só o agrupamento.
    expect(third.originAdId).toBe('ad-2');
  });
});
