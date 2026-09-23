import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';

// Lifecycle transitions an admin can drive. INVITED is set by the invite flow,
// not here.
export enum ManageableOrganizationUserStatus {
  ACTIVE = 'ACTIVE',
  BLOCKED = 'BLOCKED',
  REMOVED = 'REMOVED',
}

export class UpdateOrganizationUserStatusInputDto {
  @ApiProperty({
    enum: ManageableOrganizationUserStatus,
    example: ManageableOrganizationUserStatus.BLOCKED,
  })
  @IsEnum(ManageableOrganizationUserStatus, {
    message: 'Status must be ACTIVE, BLOCKED or REMOVED',
  })
  status: ManageableOrganizationUserStatus;
}

export class UpdateOrganizationUserStatusOutputDto {
  @ApiProperty({ example: 'uuid' })
  id: string;

  @ApiProperty({ example: 'BLOCKED' })
  status: string;
}
