import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Account } from 'src/modules/accounts/domain/entities';
import { CurrentUser } from 'src/modules/auth/infrastructure/http/decorators/current-user.decorator';
import { ManageOrganizationQuotaUseCase } from 'src/modules/organizations/application/use-cases/manage-organization-quota.usecase';
import {
  OrganizationQuotaOutputDto,
  UpdateOrganizationQuotaInputDto,
} from 'src/modules/organizations/application/dtos/organization-quota.dto';

/**
 * O teto **negociado** de uma organização — a superfície de operador.
 *
 * Rota própria, e fora de `/organizations/:id`, porque o público é outro: as
 * rotas de organização respondem ao dono e passam por `EntitlementGuard` e
 * `OrganizationAccessGuard`; esta responde a quem fecha contrato, e a
 * autorização é por papel de plataforma. Misturá-las faria uma guarda de
 * organização ter de abrir exceção para operador, que é como um bypass nasce.
 *
 * Deliberadamente **sem** `EntitlementGuard`: um operador precisa ajustar o
 * contrato justamente quando a conta está bloqueada — é o momento em que o
 * cliente ligou reclamando.
 */
@ApiTags('Gerenciar Planos')
@ApiBearerAuth()
@Controller('/api/v1/admin/organizations/:organizationId/quota')
export class OrganizationQuotasController {
  constructor(private readonly manageQuota: ManageOrganizationQuotaUseCase) {}

  @Get()
  @ApiOperation({
    summary: 'Ler o teto negociado da organização',
    description:
      'Exige a permissão de plataforma `orgs:read`. Campo nulo significa que a linha ' +
      'herda o teto do plano — nunca "ilimitado".',
  })
  @ApiOkResponse({ type: OrganizationQuotaOutputDto })
  async read(
    @Param('organizationId') organizationId: string,
    @CurrentUser() user: Account,
  ): Promise<OrganizationQuotaOutputDto> {
    return this.manageQuota.read(organizationId, user.id);
  }

  @Put()
  @ApiOperation({
    summary: 'Definir o teto negociado da organização',
    description:
      'Exige a permissão de plataforma `orgs:quota_manage`. **Omitir** um campo o deixa como ' +
      'está; enviar `null` remove o teto negociado e devolve a linha ao plano. ' +
      'Toda alteração entra na trilha de auditoria como ' +
      '`organization.quota.updated`, com o par antes/depois.',
  })
  @ApiBody({ type: UpdateOrganizationQuotaInputDto })
  @ApiOkResponse({ type: OrganizationQuotaOutputDto })
  async update(
    @Param('organizationId') organizationId: string,
    @Body() dto: UpdateOrganizationQuotaInputDto,
    @CurrentUser() user: Account,
  ): Promise<OrganizationQuotaOutputDto> {
    return this.manageQuota.update(organizationId, dto, user.id);
  }
}
