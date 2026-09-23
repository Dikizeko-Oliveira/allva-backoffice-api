import { Account } from '../entities/account.entity';
import type { PlatformRole } from '../platform-rbac';

/**
 * O desfecho de trocar um papel de plataforma.
 *
 * `LAST_ADMIN` é resultado, e não exceção, porque é o **repositório** que o
 * descobre — dentro da transação que trava as linhas de administrador — e
 * quem decide a mensagem HTTP é o use case.
 */
export type ChangePlatformRoleResult =
  | { outcome: 'UPDATED'; previousRole: PlatformRole }
  | { outcome: 'UNCHANGED' }
  | { outcome: 'LAST_ADMIN' };

export type UpdateAccountProps = {
  name?: string;
  selectedPlanId?: string;
  cpf?: string;
  phone?: string;
  address?: string;
  addressNumber?: string;
  addressComplement?: string;
  addressCity?: string;
  avatarUrl?: string;
};

export type PlatformAccountStatus = 'ACTIVE' | 'DISABLED';

export type ChangePlatformStatusResult =
  | { outcome: 'UPDATED'; previousStatus: PlatformAccountStatus }
  | { outcome: 'UNCHANGED' }
  | { outcome: 'LAST_ADMIN' };

/** Uma organização de que a conta é dona — o que impede o encerramento. */
export type OwnedOrganization = {
  id: string;
  name: string;
};

export abstract class AccountsRepositoryInterface {
  /** Contas encerradas não são encontradas: é o que fecha login e recuperação de senha. */
  abstract findByEmail(email: string): Promise<Account | null>;
  abstract findById(id: string): Promise<Account | null>;
  abstract save(account: Account): Promise<void>;
  /**
   * Apaga o dado pessoal da conta e encerra o acesso, **mantendo a linha**.
   *
   * Não é um `delete` com outro nome. O delete físico não era possível — metade
   * das FKs que apontam para `accounts` é RESTRICT e nunca some — e não era
   * desejável: o histórico da organização, a trilha de escrita em mídia paga e
   * os documentos fiscais não pertencem ao titular e têm prazo próprio.
   *
   * O que sai: nome, e-mail, CPF, telefone, endereço, foto, senha, vínculo com
   * o cliente Stripe, sessões, tokens e identidades de provedor. O que fica: a
   * linha, anônima, para as chaves estrangeiras continuarem íntegras.
   */
  abstract anonymize(id: string): Promise<void>;
  /**
   * As organizações de que esta conta é dona e que ainda existem.
   *
   * O encerramento para aqui quando há alguma: apagar o dono sem sucessor
   * deixaria a organização — e o time dentro dela — sem ninguém que possa
   * administrá-la, e o produto já tem os dois caminhos de saída (transferir a
   * posse ou excluir a organização).
   */
  abstract listOwnedOrganizations(id: string): Promise<OwnedOrganization[]>;
  abstract updatePassword(
    accountId: string,
    passwordHash: string,
  ): Promise<void>;
  abstract updateAccount(
    accountId: string,
    data: UpdateAccountProps,
  ): Promise<void>;
  abstract attachStripeCustomer(
    accountId: string,
    stripeCustomerId: string,
  ): Promise<void>;
  /** Persists the account's email-verified state after a successful verification. */
  abstract markEmailVerified(account: Account): Promise<void>;
  /**
   * Troca o papel de plataforma **sem nunca deixar a plataforma sem
   * administrador**.
   *
   * O invariante mora aqui, e não no use case, porque só uma transação com
   * trava o garante: duas requisições simultâneas rebaixando os dois últimos
   * `ALLVA_ADMIN` leriam "há dois" cada uma, as duas passariam, e ninguém
   * mais conseguiria conceder papel — nem por HTTP, nem pelo painel.
   */
  abstract changePlatformRole(
    accountId: string,
    role: PlatformRole,
  ): Promise<ChangePlatformRoleResult>;
  abstract changePlatformStatus(
    accountId: string,
    status: PlatformAccountStatus,
    actorId: string,
    reason: string,
  ): Promise<ChangePlatformStatusResult>;
}
