import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsOptional } from 'class-validator';

// OWNER is intentionally excluded: invitations can never grant ownership.
export enum InvitableOrganizationRole {
  ADMIN = 'ADMIN',
  FINANCE = 'FINANCE',
  ANALYST = 'ANALYST',
  MEMBER = 'MEMBER',
  VIEWER = 'VIEWER',
}

export class SendOrganizationInvitationInputDto {
  @ApiProperty({ example: 'jane@company.com' })
  @IsEmail({}, { message: 'Email must be valid and is required' })
  email: string;

  @ApiProperty({
    enum: InvitableOrganizationRole,
    example: InvitableOrganizationRole.MEMBER,
    default: InvitableOrganizationRole.MEMBER,
    required: false,
  })
  @IsOptional()
  @IsEnum(InvitableOrganizationRole, {
    message: 'Role must be ADMIN, FINANCE, ANALYST, MEMBER or VIEWER',
  })
  role?: InvitableOrganizationRole;
}

export class SendOrganizationInvitationOutputDto {
  @ApiProperty({ example: 'uuid' })
  id: string;

  @ApiProperty({ example: '2026-06-08T12:00:00.000Z' })
  expiresAt: Date;
}
