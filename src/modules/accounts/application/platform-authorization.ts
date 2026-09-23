import { ForbiddenException } from '@nestjs/common';
import {
  type PlatformPermission,
  isPlatformRole,
  roleHasPlatformPermission,
} from 'src/modules/accounts/domain/platform-rbac';

/**
 * A recusa de plataforma, **uma só para o produto inteiro**.
 *
 * Função, e não só método de `PlatformRoleService`, por causa do grafo de
 * módulos: `AccountsModule` importa `OrganizationsModule` e `PlansModule`, e
 * três use cases desses dois (cota, fatura avulsa, catálogo de planos)
 * precisam da mesma checagem. Injetar o serviço fecharia um ciclo, e o
 * projeto não usa `forwardRef`. Eles já carregam o ator pelo próprio
 * repositório — basta a regra, que é esta.
 *
 * Havia **quatro cópias** do mesmo `if (role !== 'ALLVA_OPERATOR' && role
 * !== 'ALLVA_ADMIN')` espalhadas por esses módulos, cada uma com a sua
 * mensagem e uma delas com 401 no lugar de 403. Uma regra de autorização
 * replicada diverge no primeiro papel novo, e a divergência de uma guarda é
 * silenciosa: o caminho que ficou para trás continua respondendo `200`.
 *
 * O código `ACCOUNT_NOT_AUTHORIZED` é o que as cópias já devolviam — mudá-lo
 * quebraria quem trata a recusa hoje. O que é novo é `details.permission`,
 * que diz ao backoffice **qual** capacidade faltou.
 */
export function assertPlatformPermission(
  actor: { role?: string | null },
  permission: PlatformPermission,
): void {
  if (roleHasPlatformPermission(actor.role, permission)) return;

  throw new ForbiddenException({
    code: 'ACCOUNT_NOT_AUTHORIZED',
    message: `Account not authorized: requires platform permission "${permission}"`,
    details: { permission },
  });
}

/**
 * A recusa **oposta**: conta de plataforma não usa o produto do cliente.
 *
 * Decisão de produto, não detalhe técnico: um operador nunca é cliente com a
 * mesma conta. Quem opera a Allva e também quer usar o produto precisa de um
 * segundo e-mail. A conta híbrida misturava as duas coisas que o RBAC separa
 * de propósito — o operador passava a ter organização, assinatura e dado de
 * cliente, e a trilha de auditoria deixava de dizer em qual papel ele agiu.
 *
 * Sem este corte, o operador sem organização caía no onboarding do cliente:
 * `/auth/me` mandava criar organização, `POST /organizations` recusava por
 * falta de assinatura e o `redirectTo` apontava para o checkout — um caminho
 * inteiro que terminava com o operador pagando um plano.
 *
 * Um código só em toda porta que recusa (guard de produto, login com
 * `audience: 'app'`, provisionamento enterprise), para o front tratar uma vez.
 */
export const PLATFORM_ACCOUNT_NOT_CUSTOMER = 'PLATFORM_ACCOUNT_NOT_CUSTOMER';

export function assertCustomerAccount(actor: { role?: string | null }): void {
  if (!isPlatformRole(actor.role)) return;

  throw new ForbiddenException({
    code: PLATFORM_ACCOUNT_NOT_CUSTOMER,
    message:
      'Platform accounts cannot use the customer product. Use a separate customer account.',
  });
}
