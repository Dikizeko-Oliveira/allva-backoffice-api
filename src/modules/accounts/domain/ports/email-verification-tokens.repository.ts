import { EmailVerificationToken } from '../entities/email-verification-token.entity';

export abstract class EmailVerificationTokensRepositoryInterface {
  abstract save(token: EmailVerificationToken): Promise<void>;
  abstract update(token: EmailVerificationToken): Promise<void>;
  /**
   * O código em aberto da conta — o mais recente que não foi usado nem expirou.
   *
   * A busca é por conta, e não por hash, porque o hash agora é escopado pela
   * conta: sem saber de quem é o código não há o que procurar. É também o que
   * permite contar tentativas erradas contra o código certo, em vez de perdê-las
   * numa consulta que simplesmente não acha nada.
   */
  abstract findPendingByAccountId(
    accountId: string,
  ): Promise<EmailVerificationToken | null>;
  /**
   * Consome todo código em aberto da conta. Chamado antes de emitir um novo,
   * para que um reenvio invalide o anterior.
   */
  abstract invalidateAllByAccountId(accountId: string): Promise<void>;
}
