import {
  ACCESS_RANK,
  AccessStatus,
  BillingStatus,
  mapBillingToAccess,
} from './access-status';
import { ContractTermView, resolveContractAccess } from './contract-access';

/**
 * O que a assinatura de **uma organização** diz sobre acesso — os três fatos
 * que o resolver lê: status, fim do teste e o contrato que a governa.
 */
export type OrganizationAccessFacts = {
  status: BillingStatus;
  trialEndsAt: Date | null;
  contract: ContractTermView | null;
};

/** O que a assinatura **pessoal** de uma conta diz sobre acesso. */
export type AccountAccessFacts = {
  billingStatus: BillingStatus;
  /** A coluna persistida. Nula cai no mapeamento de `billingStatus`. */
  accessStatus: AccessStatus | null;
  gracePeriodEndsAt: Date | null;
  planType: string | null;
  expiresAt: Date | null;
};

/**
 * O acesso que a assinatura da organização concede agora.
 *
 * **Extraído do resolver, e não reescrito ao lado dele.** A varredura dos jobs
 * precisa da mesma resposta sem uma requisição na mão, e uma segunda cópia da
 * regra é como a tolerância do contrato Enterprise passaria a valer num lugar e
 * não no outro: o produto aberto com os números parados, ou o contrário.
 *
 * **O contrato manda, quando há um.** A assinatura de uma organização
 * Enterprise nasce `ACTIVE` e sem data — de propósito: quem sabe até quando o
 * acordo vale é o contrato, e duplicar a vigência na assinatura criaria uma
 * segunda casa que envelhece na primeira renegociação. Sem o contrato aqui, o
 * `ACTIVE` da assinatura concederia acesso para sempre.
 *
 * As duas checagens são avaliadas na leitura pelo mesmo motivo: um teste ou um
 * contrato vencido ontem à noite não concede acesso hoje de manhã porque nenhum
 * job rodou no meio.
 */
export function resolveOrganizationAccess(
  facts: OrganizationAccessFacts,
  now: Date = new Date(),
): AccessStatus {
  if (facts.contract) return resolveContractAccess(facts.contract, now);

  if (
    facts.status === 'TRIALING' &&
    facts.trialEndsAt !== null &&
    facts.trialEndsAt <= now
  ) {
    return 'PAYMENT_REQUIRED';
  }

  return mapBillingToAccess(facts.status);
}

/**
 * O acesso que a assinatura pessoal concede agora.
 *
 * **Período de graça vencido** fecha na hora, sem esperar a reconciliação
 * persistir o novo status.
 *
 * **O plano FREE e o teste gratuito**: fechada a janela, não existe camada
 * gratuita para onde cair. Sem esta checagem o teste nunca terminava —
 * `Subscription.createFree` grava `expiresAt`, mas nada o lia, e como o resolver
 * devolve o contexto mais permissivo entre conta e organização, um FREE eterno
 * na conta anulava também a expiração de teste da organização. A regra é por
 * tipo de plano, não por `billingStatus`: uma assinatura Stripe em trial também
 * é `TRIALING`, e o `expiresAt` dela não acompanha o provedor — bloquear por ele
 * cortaria acesso de quem está pagando.
 */
export function resolveAccountAccess(
  facts: AccountAccessFacts,
  now: Date = new Date(),
): AccessStatus {
  if (
    facts.billingStatus === 'PAST_DUE' &&
    facts.gracePeriodEndsAt !== null &&
    facts.gracePeriodEndsAt <= now
  ) {
    return 'PAYMENT_REQUIRED';
  }

  if (
    facts.planType === 'FREE' &&
    facts.expiresAt !== null &&
    facts.expiresAt <= now
  ) {
    return 'PAYMENT_REQUIRED';
  }

  return facts.accessStatus ?? mapBillingToAccess(facts.billingStatus);
}

/** O mais permissivo de uma lista. Vazia é `BLOCKED`: ninguém concedeu nada. */
export function mostPermissiveAccess(
  statuses: readonly AccessStatus[],
): AccessStatus {
  let best: AccessStatus = 'BLOCKED';

  for (const status of statuses) {
    if (ACCESS_RANK[status] > ACCESS_RANK[best]) best = status;
  }

  return best;
}

/**
 * O acesso ao produto **desta organização**, por qualquer caminho que o
 * resolver aceite.
 *
 * O resolver responde por uma conta dentro de uma organização, e devolve o mais
 * permissivo entre a assinatura da organização e a pessoal de quem pergunta.
 * Quem pode perguntar por esta organização é o dono e todo membro ativo — é o
 * que `findEffectiveForAccount` confere. Então a organização está aberta se a
 * assinatura dela abre **ou** se a assinatura pessoal de qualquer um deles abre:
 * basta um para alguém estar olhando os números.
 *
 * Responder só pela assinatura da organização seria mais simples e fecharia a
 * varredura de quem o resolver ainda deixa entrar.
 */
export function resolveOrganizationProductAccess(input: {
  orgScopedEntitlement: boolean;
  subscription: OrganizationAccessFacts | null;
  accounts: readonly AccountAccessFacts[];
  now: Date;
}): AccessStatus {
  const candidates = input.accounts.map((facts) =>
    resolveAccountAccess(facts, input.now),
  );

  // Com `ORG_SCOPED_ENTITLEMENT` desligado o resolver ignora a organização.
  if (input.orgScopedEntitlement && input.subscription) {
    candidates.push(resolveOrganizationAccess(input.subscription, input.now));
  }

  return mostPermissiveAccess(candidates);
}
