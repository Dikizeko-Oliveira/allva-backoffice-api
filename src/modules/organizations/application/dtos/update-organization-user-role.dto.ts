import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';

// OWNER is intentionally excluded — ownership is not granted via this endpoint.
export enum AssignableOrganizationRole {
  ADMIN = 'ADMIN',
  FINANCE = 'FINANCE',
  ANALYST = 'ANALYST',
  MEMBER = 'MEMBER',
  VIEWER = 'VIEWER',
}

export class UpdateOrganizationUserRoleInputDto {
  @ApiProperty({
    enum: AssignableOrganizationRole,
    example: AssignableOrganizationRole.ADMIN,
  })
  @IsEnum(AssignableOrganizationRole, {
    message: 'Role must be ADMIN, FINANCE, ANALYST, MEMBER or VIEWER',
  })
  role: AssignableOrganizationRole;
}

export class UpdateOrganizationUserRoleOutputDto {
  @ApiProperty({ example: 'uuid' })
  id: string;

  @ApiProperty({ example: 'ADMIN' })
  role: string;
}
