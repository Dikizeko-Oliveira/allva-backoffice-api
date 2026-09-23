import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class RevokeSessionInputDto {
  @ApiProperty({
    example: '1234567890123456789012345678901234567890',
  })
  @IsString({ message: 'Session ID is required' })
  sessionId: string;
}

export class RevokeSessionOutputDto {}
