import { AccessStatus } from './access-status';

const MS_POR_DIA = 24 * 60 * 60 * 1000;

/**
 * O que o resolver precisa saber do contrato para decidir acesso.
 *
 * Fatos, e não o agregado: manter o módulo de acesso ignorante de
 * `EnterpriseContract` é o que impede a dependência de virar mão dupla — o
 * contrato já orquestra o provisionamento, e passar a ser lido *por dentro* do
 * entitlement faria dois módulos apontarem um para o outro.
 */
export type ContractTermView = {
  status: string;
  startsAt: Date;
  endsAt: Date;
  /** A tolerância negociada, em dias corridos depois do vencimento. */
  gracePeriodDays: number;
  /**
   * O vencimento da fatura mais antiga ainda em aberto — a régua da
   * inadimplência.
   *
   * Uma data, e não uma contagem de faturas, porque o que decide o acesso é
   * **há quanto tempo** o cliente deve, e não quanto. Três faturas vencidas
   * ontem são um erro de conciliação; uma vencida há noventa dias é um
   * problema.
   */
  oldestUnpaidDueAt: Date | null;
};

/**
 * O acesso que o contrato concede.
 *
 * ## Por que aqui, e não no job
 *
 * Avaliado na leitura, a cada requisição, pelo mesmo motivo que o teste
 * gratuito já é: um contrato que venceu ontem à noite não pode conceder acesso
 * hoje de manhã porque o job ainda não rodou. `ExpireOrganizationTrialsUseCase`
 * persiste o estado para relatório; quem decide o acesso é esta função.
 *
 * ## Dois eixos, nesta ordem
 *
 * **Estado comercial e vigência** primeiro: um contrato suspenso ou fora do
 * prazo não é assunto de fatura. **Saúde de pagamento** depois, e só para quem
 * passou pelo primeiro — um contrato vigente com fatura vencida há sessenta
 * dias não deveria manter o produto aberto.
 *
 * A ordem não é estética. Invertida, um contrato pré-pago que ainda não começou
 * responderia `PAYMENT_REQUIRED` por uma fatura que *deve* mesmo estar em
 * aberto, e mandaria o cliente para a tela de inadimplência em vez da de
 * espera.
 *
 * @param now injetado para que o teste descreva o calendário, e não dependa dele
 */
export function resolveContractAccess(
  contract: ContractTermView,
  now: Date = new Date(),
): AccessStatus {
  /**
   * Suspenso: fecha com saída comercial — regularizar é o caminho, e é a tela
   * de contratação que o oferece.
   */
  if (contract.status === 'SUSPENDED') return 'PAYMENT_REQUIRED';

  /**
   * Assinado e provisionado, esperando a primeira baixa
   * (`activateOnSignature: false`). Não é bloqueio: a tela de contratação
   * responde, e o acesso abre quando o pagamento entrar.
   */
  if (
    contract.status === 'SIGNED' ||
    contract.status === 'PENDING_ACTIVATION'
  ) {
    return 'PENDING_ACTIVATION';
  }

  /**
   * Contrato morto não chega aqui — e a defesa fica mesmo assim.
   *
   * O read model do entitlement traz só contratos vivos, e cancelar ou expirar
   * revoga a assinatura da organização junto. Se um estado desconhecido
   * atravessar as duas coisas, fechar é a resposta segura: o contrário
   * concederia acesso por um acordo que ninguém sabe descrever.
   */
  if (contract.status !== 'ACTIVE') return 'PAYMENT_REQUIRED';

  // Daqui para baixo só o calendário decide.
  if (now < contract.startsAt) return 'PENDING_ACTIVATION';
  if (now > contract.endsAt) return 'PAYMENT_REQUIRED';

  return resolvePaymentHealth(contract, now);
}

/**
 * O que a fatura em aberto diz sobre um contrato que, no mais, está em ordem.
 *
 * Aqui não há provedor para avisar que o pagamento falhou: o cliente paga no
 * banco, e a única evidência de inadimplência é o vencimento que passou sem
 * baixa. Por isso a régua é uma data.
 *
 * A tolerância vem do contrato porque foi negociada nele. Fechar o produto no
 * dia seguinte ao vencimento trataria o financeiro de uma empresa como um
 * cartão recusado — boleto compensa em dois dias úteis, e conciliação atrasa.
 * Dentro dela, `GRACE_PERIOD` mantém o acesso e deixa o aviso aparecer, que é
 * o que dá ao comercial a chance de ligar antes de o cliente esbarrar numa
 * porta fechada.
 *
 * ## A contagem é em dias inteiros, e não em milissegundos
 *
 * "Dez dias de tolerância" é o que foi escrito no contrato, e dez dias e três
 * milissegundos ainda é o décimo dia para quem assinou. Comparar as durações
 * cruas fechava o acesso no instante em que o relógio passava do vencimento
 * mais a graça — o que na prática entrega **nove** dias, porque a igualdade
 * exata só acontece num teste que constrói as duas datas do mesmo número.
 */
function resolvePaymentHealth(
  contract: ContractTermView,
  now: Date,
): AccessStatus {
  if (!contract.oldestUnpaidDueAt) return 'ALLOWED';

  const overdueMs = now.getTime() - contract.oldestUnpaidDueAt.getTime();
  if (overdueMs <= 0) return 'ALLOWED';

  const overdueDays = Math.floor(overdueMs / MS_POR_DIA);

  return overdueDays <= contract.gracePeriodDays
    ? 'GRACE_PERIOD'
    : 'PAYMENT_REQUIRED';
}
