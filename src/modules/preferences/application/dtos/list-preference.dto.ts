import { ApiProperty } from '@nestjs/swagger';

class PreferenceDto {
  @ApiProperty({ example: 'uuid' })
  id: string;

  @ApiProperty({ example: 'uuid' })
  accountId: string;

  @ApiProperty({ example: true })
  notificationByEmail: boolean;

  @ApiProperty({ example: false })
  dailyResume: boolean;

  @ApiProperty({ example: true })
  alertNotifications: boolean;

  @ApiProperty({ example: true })
  promotionNotifications: boolean;

  @ApiProperty({ example: true })
  productNewsNotification: boolean;

  @ApiProperty({ example: '2026-03-15T00:00:00.000Z' })
  createdAt: Date;
}

export class ListPreferenceOutputDto {
  @ApiProperty({ type: PreferenceDto })
  preference: PreferenceDto;
}
