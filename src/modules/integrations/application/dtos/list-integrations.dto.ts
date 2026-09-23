import { ApiProperty } from '@nestjs/swagger';
import { IntegrationDto } from './integration.dto';

export class ListIntegrationsOutputDto {
  @ApiProperty({ type: [IntegrationDto] })
  integrations!: IntegrationDto[];
}
