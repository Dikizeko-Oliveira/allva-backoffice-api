import {
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import { AuditLogService } from 'src/modules/audit/application';
import { DeleteOrganizationUseCase } from 'src/modules/organizations/application/use-cases';
import { CancelSubscriptionUseCase } from 'src/modules/subscriptions/application/use-cases';

/**
 * Os dois motivos pelos quais cancelar não é obrigação de quem exclui a conta.
 *
 * `SUBSCRIPTION_NOT_FOUND` é o caso do teste gratuito que nunca passou pelo
 * checkout; `SUBSCRIPTION_ALREADY_CANCELED`, o de quem já cancelou e só depois
 * decidiu encerrar a conta. Nos dois, não há nada a cancelar — e transformar
 * isso em erro faria o encerramento falhar por um estado que já é o desejado.
 */
const NOTHING_TO_CANCEL = new Set([
  'SUBSCRIPTION_NOT_FOUND',
  'SUBSCRIPTION_ALREADY_CANCELED',
]);

/**
 * Lê o `code` do corpo de uma exceção HTTP.
 *
 * Por `getResponse()`, e não pelo campo `response`: ele é `private readonly` na
 * declaração do `HttpException`. Alcançá-lo funcionaria — `private` do
 * TypeScript não existe em runtime —, mas passaria a depender de detalhe
 * interno do Nest, e uma atualização que o renomeasse quebraria o encerramento
 * de conta em silêncio, sem nenhum teste acusar.
 */
function errorCode(error: unknown): string | undefined {
  if (!(error instanceof HttpException)) return undefined;

  const body = error.getResponse();
  if (typeof body !== 'object' || body === null) return undefined;

  const code = (body as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * O encerramento da conta a pedido do titular.
 *
 * **Anonimiza; não apaga a linha.** O delete físico anterior não chegava a
 * rodar: `preferences`, `integrations`, `organization_users`, `organizations` e
 * `support_tickets` referenciam `accounts` com ON DELETE RESTRICT e nunca somem
 * do banco — exclusão de organização e remoção de membro são soft delete —, de
 * modo que `DELETE FROM accounts` levantava violação de FK para qualquer conta
 * real. Não havia tratamento para isso, então o titular recebia 500 ao exercer
 * um direito.
 *
 * E, mesmo que passasse, apagar a linha era a coisa errada: levaria junto
 * registro que não é do titular (o histórico da organização) ou que tem prazo
 * legal próprio (nota fiscal, trilha de escrita em mídia paga). O que a LGPD
 * pede é que o dado pessoal deixe de existir — não que a contabilidade suma.
 */
@Injectable()
export class DeleteAccountUseCase {
  private readonly logger = new Logger(DeleteAccountUseCase.name);

  constructor(
    private readonly accountsRepository: AccountsRepositoryInterface,
    private readonly cancelSubscription: CancelSubscriptionUseCase,
    private readonly deleteOrganization: DeleteOrganizationUseCase,
    private readonly auditLog: AuditLogService,
  ) {}

  async execute(accountId: string): Promise<void> {
    const account = await this.accountsRepository.findById(accountId);

    if (!account) {
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Account not found',
      });
    }

    // A cobrança para antes do dado sair. Na ordem inversa, uma falha na
    // anonimização deixaria a assinatura cancelada numa conta que continua de
    // pé; nesta, uma falha depois do cancelamento deixa a conta viva sem
    // assinatura — recuperável, e visível para o titular.
    await this.cancelSubscriptionIfActive(accountId);

    // As organizações de que o titular é dono vão junto.
    //
    // **Não é cascata por conveniência.** Excluir uma organização já é poder
    // exclusivo do dono — ninguém mais pode, em nenhum caminho —, então exigir
    // que ele transferisse a posse antes de sair seria pedir que escolhesse um
    // sucessor para algo que ele tem todo o direito de encerrar. Quem quer que a
    // organização sobreviva transfere a posse **antes**, como ato deliberado; é
    // o mesmo endpoint de sempre, e continua ali.
    //
    // O caso de uso de organização é reusado inteiro para que a cascata
    // (participações, convites, trilha) não exista em duas versões que divergem.
    const owned =
      await this.accountsRepository.listOwnedOrganizations(accountId);

    for (const organization of owned) {
      await this.deleteOrganization.execute({
        organizationId: organization.id,
        accountId,
        membershipId: null,
        role: 'OWNER',
      });
    }

    await this.accountsRepository.anonymize(accountId);

    // O evento continua `account.deleted`: do ponto de vista de quem lê a
    // trilha, a conta foi encerrada. A anonimização é o como, não o quê.
    //
    // O que mudou é o metadado: sem `email`. A versão anterior o gravava aqui, e
    // `audit_logs` é isento de retenção — o endereço que a exclusão apagava da
    // conta ficava guardado, para sempre, no registro da própria exclusão.
    await this.auditLog.record({
      event: 'account.deleted',
      entityType: 'account',
      entityId: accountId,
      actorId: accountId,
    });

    this.logger.log(`account.anonymized accountId=${accountId}`);
  }

  private async cancelSubscriptionIfActive(accountId: string): Promise<void> {
    try {
      await this.cancelSubscription.execute(accountId);
    } catch (error) {
      if (NOTHING_TO_CANCEL.has(errorCode(error) ?? '')) return;
      throw error;
    }
  }
}
