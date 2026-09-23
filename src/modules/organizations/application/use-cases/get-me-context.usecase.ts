import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import {
  type PlatformPermission,
  type PlatformRole,
  isPlatformRole,
  permissionsForRole,
} from 'src/modules/accounts/domain/platform-rbac';
import {
  OrganizationsRepositoryInterface,
  OrganizationUsersRepositoryInterface,
} from 'src/modules/organizations/domain/ports';
import { OrganizationRole } from 'src/modules/organizations/domain/rbac';
import { PermissionResolverService } from 'src/modules/organizations/application/permission-resolver.service';
import {
  OnboardingStateService,
  OnboardingSummary,
} from 'src/modules/organizations/application/onboarding-state.service';
import {
  WorkspaceContext,
  noOrganizationWorkspace,
} from 'src/modules/organizations/application/workspace-context';

type NoOrganizationSummary = { type: 'NO_ORGANIZATION' };
type OrganizationWorkspaceSummary = {
  type: 'ORGANIZATION';
  organizationId: string;
  name: string;
  role: OrganizationRole;
};

export type MeContextOutput = {
  account: { id: string; name: string; email: string };
  /**
   * O papel de **plataforma** — `null` para toda conta de cliente.
   *
   * É o B0 do mapa de endpoints do backoffice, e o que o bloqueava inteiro:
   * o JWT carrega só `{ sub, sid, email, name }`, e sem isto o painel não
   * tinha como saber se quem entrou é operador. Todo o RBAC dele era mock.
   *
   * Viaja para exibição e telemetria. **Nenhuma tela deve decidir por ele** —
   * a decisão é `platformPermissions.includes(...)`, pela razão que o próprio
   * backoffice documenta: uma matriz reimplementada no cliente diverge na
   * primeira permissão nova, e o lado desatualizado continua deixando passar.
   */
  platformRole: PlatformRole | null;
  /** Já resolvidas pela matriz do servidor. Vazio para `USER`. */
  platformPermissions: PlatformPermission[];
  currentWorkspace:
    | NoOrganizationSummary
    | { type: 'ORGANIZATION'; organizationId: string; role: OrganizationRole };
  availableWorkspaces: OrganizationWorkspaceSummary[];
  membership: {
    membershipId: string;
    status: string;
    role: OrganizationRole;
  } | null;
  permissions: string[];
  /**
   * Onde a conta parou no caminho até o produto ter o que mostrar.
   *
   * Entra aqui, e não numa rota própria, porque esta resposta já é a fonte de
   * verdade de autorização do frontend — e a pergunta "o que posso fazer" e "o
   * que falta fazer" são lidas pela mesma tela, no mesmo instante. Duas rotas
   * significariam dois estados que podem discordar entre si.
   */
  onboarding: OnboardingSummary;
};

/**
 * Builds the consolidated "who am I + where am I + what can I do" payload that
 * the frontend consumes as its single source of truth for authorization. All
 * fields are derived server-side from the resolved WorkspaceContext and the
 * account's memberships — the client never decides permissions.
 */
@Injectable()
export class GetMeContextUseCase {
  constructor(
    private readonly accountsRepository: AccountsRepositoryInterface,
    private readonly organizationUsersRepository: OrganizationUsersRepositoryInterface,
    private readonly organizationsRepository: OrganizationsRepositoryInterface,
    private readonly permissionResolver: PermissionResolverService,
    private readonly onboarding: OnboardingStateService,
  ) {}

  async execute(
    accountId: string,
    workspaceContext?: WorkspaceContext,
  ): Promise<MeContextOutput> {
    const account = await this.accountsRepository.findById(accountId);

    if (!account) {
      throw new UnauthorizedException({
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
      });
    }

    // Só alcança este fallback quem chamar o caso de uso fora do ciclo HTTP: o
    // middleware resolve o workspace de toda requisição autenticada.
    const currentContext =
      workspaceContext ?? noOrganizationWorkspace(accountId);

    // Active memberships drive both availableWorkspaces and the current
    // membership lookup; soft-deleted ones are already excluded by the repo.
    const memberships = (
      await this.organizationUsersRepository.listByAccountId(accountId)
    ).filter((membership) => membership.isActive());

    const organizations = await this.organizationsRepository.listByIds(
      memberships.map((membership) => membership.organizationId),
    );
    const organizationNameById = new Map(
      organizations.map((organization) => [organization.id, organization.name]),
    );

    const organizationWorkspaces: OrganizationWorkspaceSummary[] = memberships
      // An org whose row is missing/soft-deleted is not offered.
      .filter((membership) =>
        organizationNameById.has(membership.organizationId),
      )
      .map((membership) => ({
        type: 'ORGANIZATION' as const,
        organizationId: membership.organizationId,
        name: organizationNameById.get(membership.organizationId) as string,
        role: membership.role,
      }));

    /**
     * Só organizações. Uma lista vazia é a resposta certa para quem não alcança
     * nenhuma — não há workspace alternativo para oferecer.
     *
     * Havia aqui um `{ type: 'PERSONAL' }` fixo, sempre presente. Ele virou item
     * fantasma quando o cadastro passou a provisionar organização: o seletor
     * mostrava "Workspace pessoal" ao lado da organização da conta como se
     * fossem escolhas equivalentes. Não são — anúncio, integração, desperdício e
     * recomendação são todos escopados por organização, e `Ad.organization_id` é
     * NOT NULL. Escolher o pessoal levava a um lugar sem nada para mostrar.
     */
    const availableWorkspaces = organizationWorkspaces;

    const currentMembership =
      currentContext.type === 'ORGANIZATION'
        ? memberships.find(
            (membership) =>
              membership.organizationId === currentContext.organizationId,
          )
        : undefined;

    return {
      account: {
        id: account.id,
        name: account.name,
        email: account.email,
      },
      platformRole: isPlatformRole(account.role) ? account.role : null,
      platformPermissions: permissionsForRole(account.role),
      currentWorkspace:
        currentContext.type === 'ORGANIZATION'
          ? {
              type: 'ORGANIZATION',
              organizationId: currentContext.organizationId,
              role: currentContext.role,
            }
          : { type: 'NO_ORGANIZATION' },
      availableWorkspaces,
      membership: currentMembership
        ? {
            membershipId: currentMembership.id,
            status: currentMembership.status,
            role: currentMembership.role,
          }
        : null,
      permissions: this.permissionResolver.resolvePermissions(currentContext),
      onboarding: await this.onboarding.resolve(
        accountId,
        currentContext.type === 'ORGANIZATION'
          ? currentContext.organizationId
          : null,
        { platformAccount: isPlatformRole(account.role) },
      ),
    };
  }
}
