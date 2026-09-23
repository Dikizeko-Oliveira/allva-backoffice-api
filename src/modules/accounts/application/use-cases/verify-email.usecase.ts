import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Account } from 'src/modules/accounts/domain/entities';
import {
  AccountsRepositoryInterface,
  EmailVerificationTokensRepositoryInterface,
} from 'src/modules/accounts/domain/ports';
import { AccountOnboardingService } from 'src/modules/accounts/application/services/account-onboarding.service';
import { AuditLogService } from 'src/modules/audit/application';
import { BruteForceProtectionService } from 'src/modules/security/application';

export type VerifyEmailInput = {
  email: string;
  code: string;
  ipAddress?: string;
  userAgent?: string;
};

export type VerifyEmailResult = {
  accountId: string;
  emailVerified: true;
  /**
   * A conta confirmada, para quem chama emitir a sessão.
   *
   * Quem emite é o `AuthController`, e não este caso de uso: sessão é assunto
   * do módulo de auth, que já depende de accounts — inverter a seta aqui
   * fecharia um ciclo entre os dois módulos por uma linha de conveniência.
   */
  account: Account;
};

@Injectable()
export class VerifyEmailUseCase {
  private readonly logger = new Logger(VerifyEmailUseCase.name);

  constructor(
    private readonly accountsRepository: AccountsRepositoryInterface,
    private readonly tokensRepository: EmailVerificationTokensRepositoryInterface,
    private readonly onboarding: AccountOnboardingService,
    private readonly auditLog: AuditLogService,
    private readonly bruteForce: BruteForceProtectionService,
  ) {}

  /**
   * Um erro só para código errado, expirado, já usado, conta inexistente e
   * conta já confirmada.
   *
   * Distinguir qualquer um deles daria a quem chuta um retorno diferente para
   * "este email tem conta" — e a diferença entre "código inválido" e "conta não
   * encontrada" é toda a enumeração de base que um endpoint público precisa
   * negar.
   */
  private invalidCode(): BadRequestException {
    return new BadRequestException({
      code: 'VERIFICATION_CODE_INVALID',
      message: 'Código inválido ou expirado. Solicite um novo código.',
    });
  }

  async execute(input: VerifyEmailInput): Promise<VerifyEmailResult> {
    const email = input.email.trim().toLowerCase();

    const bruteForceKey = {
      scope: 'email_verification' as const,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      accountKey: email,
    };

    // O teto por código (5 tentativas) morre quando a conta pede outro; o
    // bloqueio progressivo é o que sobrevive ao reenvio e fecha o loop
    // "reenvia, chuta cinco vezes, reenvia".
    await this.bruteForce.assertNotLocked(bruteForceKey);

    const account = await this.accountsRepository.findByEmail(email);

    if (!account || account.emailVerified) {
      await this.bruteForce.registerFailure(bruteForceKey);
      this.logger.warn('email_verification.failed reason=no_pending_account');
      throw this.invalidCode();
    }

    const token = await this.tokensRepository.findPendingByAccountId(
      account.id,
    );

    // `findPendingByAccountId` já filtra usado e expirado; `isPending` cobre o
    // que só o domínio sabe — o teto de tentativas.
    if (!token || !token.isPending()) {
      await this.bruteForce.registerFailure({
        ...bruteForceKey,
        accountId: account.id,
      });
      this.logger.warn('email_verification.failed reason=no_pending_code');
      throw this.invalidCode();
    }

    if (!token.matches(account.id, input.code)) {
      // O palpite errado é gravado **antes** de responder: sem isso o teto de
      // tentativas não existiria, e seis dígitos cairiam num varredura.
      token.registerFailedAttempt();
      await this.tokensRepository.update(token);

      await this.bruteForce.registerFailure({
        ...bruteForceKey,
        accountId: account.id,
      });

      this.logger.warn(
        `email_verification.failed reason=wrong_code accountId=${account.id} attempts=${token.attempts}`,
      );
      throw this.invalidCode();
    }

    // Consome primeiro: mesmo que a atualização da conta falhe, o código não
    // pode ser reutilizado.
    token.markAsUsed();
    await this.tokensRepository.update(token);

    account.markEmailVerified();
    await this.accountsRepository.markEmailVerified(account);

    await this.auditLog.record({
      event: 'account.email_verified',
      entityType: 'account',
      entityId: account.id,
      actorId: account.id,
    });

    // Agora que o endereço está confirmado, entrega o email de boas-vindas que
    // o cadastro por senha deliberadamente segurou.
    await this.onboarding.execute(account, { sendWelcomeEmail: true });

    this.logger.log(`email_verification.confirmed accountId=${account.id}`);

    return { accountId: account.id, emailVerified: true, account };
  }
}
