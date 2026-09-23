import { ApiProperty } from '@nestjs/swagger';

export class RemoveOrganizationUserOutputDto {
  @ApiProperty({ example: 'uuid' })
  id: string;

  @ApiProperty({ example: 'REMOVED' })
  status: string;
}
