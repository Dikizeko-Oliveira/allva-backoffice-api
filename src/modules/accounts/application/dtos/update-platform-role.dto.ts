import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import {
  PLATFORM_PERMISSIONS,
  PLATFORM_ROLES,
  type PlatformPermission,
  type PlatformRole,
} from 'src/modules/accounts/domain/platform-rbac';

/**
 * O corpo que o backoffice já envia (`updateOperatorRoleSchema` em
 * `allva-backoffice-web`): só o papel novo.
 *
 * Sem `USER` na lista, de propósito. Tirar alguém da plataforma não é trocar
 * de papel — é suspender o acesso (B18, com motivo obrigatório), e fazer as
 * duas coisas pela mesma rota deixaria "mudei de área" e "desliguei a pessoa"
 * indistinguíveis na trilha.
 */
export class UpdatePlatformRoleInputDto {
  @ApiProperty({ enum: PLATFORM_ROLES, example: 'ALLVA_SUPPORT' })
  @IsIn(PLATFORM_ROLES, {
    message: `platformRole must be one of: ${PLATFORM_ROLES.join(', ')}`,
  })
  platformRole: PlatformRole;
}

export class UpdatePlatformRoleOutputDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  email: string;

  @ApiProperty({ enum: PLATFORM_ROLES })
  platformRole: PlatformRole;

  @ApiProperty({
    enum: PLATFORM_PERMISSIONS,
    isArray: true,
    description:
      'As permissões que o papel novo concede, já resolvidas — para o painel atualizar a linha sem reimplementar a matriz.',
  })
  platformPermissions: PlatformPermission[];
}
