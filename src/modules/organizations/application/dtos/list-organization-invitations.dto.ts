import { ApiProperty } from '@nestjs/swagger';

export class OrganizationInvitationItemDto {
  @ApiProperty({ example: 'uuid' })
  id: string;

  @ApiProperty({ example: 'jane@company.com' })
  email: string;

  @ApiProperty({ example: 'MEMBER' })
  role: string;

  @ApiProperty({
    example: 'PENDING',
    enum: ['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED'],
  })
  status: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';

  @ApiProperty({ example: 'uuid' })
  invitedBy: string;

  @ApiProperty({ example: '2026-06-08T12:00:00.000Z' })
  expiresAt: Date;

  @ApiProperty({ example: null, nullable: true })
  acceptedAt: Date | null;

  @ApiProperty({ example: null, nullable: true })
  revokedAt: Date | null;

  @ApiProperty({ example: '2026-06-01T12:00:00.000Z' })
  createdAt: Date;
}

export class ListOrganizationInvitationsOutputDto {
  @ApiProperty({ type: [OrganizationInvitationItemDto] })
  invitations: OrganizationInvitationItemDto[];
}
