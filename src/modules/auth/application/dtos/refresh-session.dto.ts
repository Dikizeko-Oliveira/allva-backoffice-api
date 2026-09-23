import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class RefreshSessionInputDto {
  @ApiProperty({
    example: '1234567890123456789012345678901234567890',
  })
  @IsString({ message: 'Refresh token is required' })
  refreshToken: string;
}

export class RefreshSessionOutputDto {
  @ApiProperty({
    description: 'Short-lived JWT access token',
  })
  accessToken: string;

  @ApiProperty({
    description: 'Long-lived refresh token',
  })
  refreshToken: string;
}
