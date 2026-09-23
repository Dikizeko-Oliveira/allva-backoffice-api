import { OrganizationRole } from 'src/modules/organizations/domain/rbac';
import { OrganizationContext } from 'src/modules/organizations/application/organization-context.resolver';

/**
 * O workspace em que a requisição corre.
 *
 * São dois estados, e só um deles é um lugar: ou a requisição corre **dentro de
 * uma organização** — participação ativa, resolvida no servidor —, ou a conta
 * **não alcança nenhuma**, que é condição a resolver, não destino.
 *
 * `NO_ORGANIZATION` chamava-se `PERSONAL`, e o nome era a origem de dois
 * defeitos. Ele prometia um workspace com recursos próprios, e o produto passou
 * a ser organization-first: `Ad`, `Integration`, waste e recomendações são todos
 * escopados por organização, e as colunas são NOT NULL. Não há nada para ver
 * lá. Enquanto o nome sugeria que havia, o seletor oferecia "Workspace pessoal"
 * como alternativa equivalente à organização da conta, e o `/auth/me` respondia
 * com um conjunto de permissões que nenhum guard verifica — que foi o que
 * deixou a tela de organização em skeleton eterno, com dado em mãos e sem
 * autoridade para exibi-lo.
 *
 * O estado continua existindo porque continua sendo alcançável: o
 * provisionamento do cadastro é best-effort de propósito (uma falha nunca custa
 * a conta ao usuário), e o resgate do gateway — que limpa o cookie de
 * organização quando ele aponta para uma inacessível — depende de uma
 * requisição sem header resolver limpo. O que mudou é que ele agora se anuncia
 * como o que é, e `onboarding.nextStep` diz o que fazer a respeito.
 *
 * O workspace NUNCA é persistido na conta: é estado contextual da requisição,
 * inferido dinamicamente.
 */
export type WorkspaceContext =
  | {
      type: 'NO_ORGANIZATION';
      accountId: string;
    }
  | {
      type: 'ORGANIZATION';
      accountId: string;
      organizationId: string;
      membershipId: string | null;
      role: OrganizationRole;
    };

export function noOrganizationWorkspace(accountId: string): WorkspaceContext {
  return { type: 'NO_ORGANIZATION', accountId };
}

/**
 * Lifts an already-resolved (authorized) OrganizationContext into a
 * WorkspaceContext. Reuses the existing resolver/middleware output instead of
 * re-validating membership.
 */
export function organizationWorkspace(
  context: OrganizationContext,
): WorkspaceContext {
  return {
    type: 'ORGANIZATION',
    accountId: context.accountId,
    organizationId: context.organizationId,
    membershipId: context.membershipId,
    role: context.role,
  };
}
