import { ApiProperty } from '@nestjs/swagger';

export class DeleteOrganizationOutputDto {
  @ApiProperty({ example: 'uuid' })
  id: string;

  @ApiProperty({ example: '2026-06-01T12:00:00.000Z' })
  deletedAt: Date;
}
