import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class AcceptOrganizationInvitationInputDto {
  @ApiProperty({
    description: 'Raw invitation token received by email.',
    example: 'M2x5...redacted',
  })
  @IsString({ message: 'Token is required' })
  @MinLength(1, { message: 'Token is required' })
  token: string;
}

export class AcceptOrganizationInvitationOutputDto {
  @ApiProperty({ example: 'uuid' })
  organizationId: string;

  @ApiProperty({ example: 'uuid' })
  organizationUserId: string;

  @ApiProperty({ example: 'MEMBER' })
  role: string;
}
