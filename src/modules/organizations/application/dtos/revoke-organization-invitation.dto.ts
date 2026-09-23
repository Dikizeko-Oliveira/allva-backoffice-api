import { ApiProperty } from '@nestjs/swagger';

export class RevokeOrganizationInvitationOutputDto {
  @ApiProperty({ example: 'uuid' })
  id: string;

  @ApiProperty({ example: '2026-06-02T12:00:00.000Z' })
  revokedAt: Date;
}
