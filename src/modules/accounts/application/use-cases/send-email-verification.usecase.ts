import { Injectable, Logger } from '@nestjs/common';
import {
  Account,
  EmailVerificationToken,
} from 'src/modules/accounts/domain/entities';
import {
  AccountsRepositoryInterface,
  EmailVerificationTokensRepositoryInterface,
} from 'src/modules/accounts/domain/ports';
import {
  EmailSenderPortInterface,
  EmailTemplateRendererPortInterface,
} from 'src/shared/application/ports';

@Injectable()
export class SendEmailVerificationUseCase {
  private readonly logger = new Logger(SendEmailVerificationUseCase.name);

  constructor(
    private readonly accountsRepository: AccountsRepositoryInterface,
    private readonly tokensRepository: EmailVerificationTokensRepositoryInterface,
    private readonly emailSender: EmailSenderPortInterface,
    private readonly emailTemplates: EmailTemplateRendererPortInterface,
  ) {}

  /**
   * Emite um código novo para uma conta já em mãos. Usado logo após o cadastro,
   * onde a conta existe e é sempre não verificada.
   */
  async executeForAccount(account: Account): Promise<void> {
    if (account.emailVerified) return;

    // Um código novo invalida o anterior, para que um email antigo não possa
    // ser reaproveitado depois de um reenvio — e para que exista no máximo um
    // código em aberto por conta, que é o que a verificação assume.
    await this.tokensRepository.invalidateAllByAccountId(account.id);

    const { code, codeHash } = EmailVerificationToken.generateCode(account.id);

    await this.tokensRepository.save(
      EmailVerificationToken.create({
        accountId: account.id,
        tokenHash: codeHash,
      }),
    );

    const { subject, html, text } = await this.emailTemplates.render(
      'email-verification',
      {
        name: account.name,
        code,
        expiresInMinutes: EmailVerificationToken.ttlMinutes,
      },
    );

    await this.emailSender.send({ to: account.email, subject, html, text });

    // O código nunca entra no log: quem lê o log da aplicação passaria a poder
    // confirmar contas alheias.
    this.logger.log(`email_verification.sent accountId=${account.id}`);
  }

  /**
   * Porta de entrada do reenvio. Sempre resolve com sucesso — um endereço
   * desconhecido ou já verificado precisa ser indistinguível de um envio real,
   * ou o endpoint vira um oráculo de enumeração de contas.
   */
  async execute(email: string): Promise<void> {
    const account = await this.accountsRepository.findByEmail(
      email.trim().toLowerCase(),
    );

    if (!account || account.emailVerified) {
      this.logger.debug(
        'email_verification.resend_noop (unknown or already verified)',
      );
      return;
    }

    await this.executeForAccount(account);
  }
}
