import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { ContactStatusValues } from '../../domain/entities';

enum ContactStatusInput {
  NEW = 'NEW',
  READ = 'READ',
  REPLIED = 'REPLIED',
  ARCHIVED = 'ARCHIVED',
}

export class UpdateContactStatusInputDto {
  @ApiProperty({
    enum: ContactStatusInput,
    example: ContactStatusInput.READ,
  })
  @IsEnum(ContactStatusInput, {
    message: `Status must be one of: ${ContactStatusValues.join(', ')}`,
  })
  status: ContactStatusInput;
}

export class UpdateContactStatusOutputDto {
  @ApiProperty({ example: 'uuid' })
  id: string;

  @ApiProperty({ example: 'READ' })
  status: string;
}
