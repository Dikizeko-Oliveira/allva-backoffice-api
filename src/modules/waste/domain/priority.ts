import type { EvidenceSufficiency } from 'src/shared/domain/provenance';
import type { WastePriority } from './contracts/finding-catalog';

/**
 * Prioridade derivada da **fração do gasto diário que a ação interrompe**, não
 * de um valor absoluto.
 *
 * Um limiar em dinheiro ("acima de R$ 500/dia é crítico") não é comparável entre
 * organizações nem entre moedas: R$ 500/dia é a conta inteira de um anunciante e
 * ruído no de outro. A fração responde a pergunta que o usuário faz — *"quanto
 * do que este anúncio queima por dia eu paro se agir?"* — e é a mesma pergunta
 * em qualquer moeda e em qualquer tamanho de conta.
 */

const CRITICAL_SHARE = 0.9;
const HIGH_SHARE = 0.5;
const MEDIUM_SHARE = 0.2;

export function priorityFor(input: {
  avoidableDailyBase: number;
  dailySpendBase: number;
  sufficiency: EvidenceSufficiency;
}): WastePriority {
  const share =
    input.dailySpendBase > 0
      ? input.avoidableDailyBase / input.dailySpendBase
      : 0;

  const nominal: WastePriority =
    share >= CRITICAL_SHARE
      ? 'CRITICAL'
      : share >= HIGH_SHARE
        ? 'HIGH'
        : share >= MEDIUM_SHARE
          ? 'MEDIUM'
          : 'LOW';

  // DEC-3: *"a recomendação derivada herda a confiança reduzida"*. Um achado
  // apoiado na linha de base da conta — outro público, outro leilão — não pode
  // ocupar o topo da lista ao lado de um medido contra os pares diretos. O teto
  // é como a degradação chega à ordenação, e não só ao rótulo.
  if (input.sufficiency !== 'SUFFICIENT' && nominal === 'CRITICAL') {
    return 'HIGH';
  }

  return nominal;
}
