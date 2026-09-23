import { Controller, Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from 'src/modules/auth/infrastructure/http/decorators/current-user.decorator';
import { Account } from 'src/modules/accounts/domain/entities';
import { GetMeContextUseCase } from 'src/modules/organizations/application/use-cases';
import { CurrentWorkspace } from 'src/modules/organizations/infrastructure/http/decorators/current-workspace.decorator';
import { WorkspaceContext } from 'src/modules/organizations/application/workspace-context';

/**
 * Consolidated identity + workspace + permissions endpoint. The frontend uses
 * this as its single source of truth for authorization instead of inferring
 * access from roles client-side. The active workspace is selected by the
 * X-Organization-Id header, resolved server-side. Ausente significa a
 * organização **padrão** da conta; `NO_ORGANIZATION` só aparece para quem não
 * alcança nenhuma, e nesse caso `onboarding.nextStep` diz o que fazer.
 */
@ApiTags('Autenticação')
@ApiBearerAuth()
@Controller('/api/v1/auth')
export class MeController {
  constructor(private readonly getMeContext: GetMeContextUseCase) {}

  @Get('me')
  @ApiOperation({
    summary:
      'Retorna conta, workspace atual, workspaces disponíveis, membership, ' +
      'permissões efetivas e o estado de onboarding',
    description:
      '`onboarding.nextStep` é a decisão do servidor sobre para onde a tela ' +
      'deve levar o usuário: `USE_BACKOFFICE` (conta de plataforma — não usa ' +
      'o produto do cliente), `CREATE_ORGANIZATION`, `SUBSCRIBE`, ' +
      '`CONNECT_PLATFORM`, `LINK_AD_ACCOUNT`, `AWAITING_FIRST_SYNC` ou ' +
      '`READY`. Os booleanos ao lado existem para a tela explicar o porquê, ' +
      'não para ela recalcular o passo. `platformRole`/`platformPermissions` ' +
      'respondem pela **plataforma** (painel de operador), não pela ' +
      'organização: `null`/`[]` para toda conta de cliente. Autorize por ' +
      '`platformPermissions`, nunca pelo papel.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        account: { id: '', name: '', email: '' },
        platformRole: null,
        platformPermissions: [],
        currentWorkspace: {
          type: 'ORGANIZATION',
          organizationId: '',
          role: 'ADMIN',
        },
        availableWorkspaces: [
          { type: 'ORGANIZATION', organizationId: '', name: '', role: 'ADMIN' },
        ],
        membership: { membershipId: '', status: 'ACTIVE', role: 'ADMIN' },
        permissions: ['organization:read', 'members:read'],
        onboarding: {
          hasOrganization: true,
          hasActiveSubscription: true,
          hasConnectedIntegration: false,
          hasLinkedAdAccount: false,
          hasSyncedAds: false,
          nextStep: 'CONNECT_PLATFORM',
        },
      },
    },
  })
  async me(
    @CurrentUser() user: Account,
    @CurrentWorkspace() workspace?: WorkspaceContext,
  ) {
    return this.getMeContext.execute(user.id, workspace);
  }
}
