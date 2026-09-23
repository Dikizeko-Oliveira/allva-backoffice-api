import { Prisma } from 'generated/prisma/client';
import type { ContractTermView } from 'src/modules/subscriptions/access/domain/contract-access';

/**
 * Os contratos vivos de uma organização, como a decisão de acesso os lê.
 *
 * **Uma consulta para os dois leitores**: o resolver de cada requisição e a
 * varredura dos jobs. Se as duas divergissem, a tolerância do contrato valeria
 * para a tela e não para o sync, e o cliente em dia com o boleto veria números
 * parados.
 *
 * `CANCELED`, `EXPIRED` e `RENEWED` ficam de fora: são história, e um contrato
 * morto disputando a resposta com o que o substituiu daria acesso pelo passado.
 * Mais de um, e não `take: 1`, porque depois da primeira renovação há dois vivos
 * ao mesmo tempo — quem desempata é `selectGoverningContract`, e a regra dele
 * não é a que um `orderBy` consegue expressar. `take: 5` é folga: a invariante é
 * no máximo dois vivos.
 *
 * Das faturas, só a em aberto mais antiga — a régua da inadimplência é há
 * quanto tempo o cliente deve, e não quanto. `PAID` foi quitada; `CANCELED` e
 * `EXPIRED` o operador já baixou da carteira, e cobrar acesso por elas seria
 * punir o cliente por decisão nossa.
 */
export const LIVE_CONTRACTS_QUERY = {
  where: {
    status: { in: ['SIGNED', 'PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED'] },
  },
  orderBy: { startsAt: 'desc' },
  take: 5,
  include: {
    invoices: {
      where: { status: { in: ['PENDING', 'FAILED'] } },
      orderBy: { dueAt: 'asc' },
      select: { dueAt: true },
      take: 1,
    },
  },
} satisfies Prisma.EnterpriseContractFindManyArgs;

type LiveContractRow = {
  status: string;
  startsAt: Date;
  endsAt: Date;
  gracePeriodDays: number;
  invoices?: Array<{ dueAt: Date | null }>;
};

/** A parte do contrato que decide acesso. */
export function contractTermOf(contract: LiveContractRow): ContractTermView {
  return {
    status: contract.status,
    startsAt: contract.startsAt,
    endsAt: contract.endsAt,
    gracePeriodDays: contract.gracePeriodDays,
    // Fatura sem vencimento não atrasa: sem data não há régua, e inventar uma
    // fecharia acesso por um prazo que ninguém combinou.
    oldestUnpaidDueAt: contract.invoices?.[0]?.dueAt ?? null,
  };
}
