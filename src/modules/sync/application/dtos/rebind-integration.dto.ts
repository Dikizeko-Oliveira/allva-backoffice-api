import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class RebindIntegrationDto {
  @ApiProperty({
    description:
      'A credencial recém-conectada que passa a servir as contas desta organização. ' +
      'A anterior é revogada; a linha de `Integration` é preservada para auditoria.',
  })
  @IsUUID('4')
  integrationId!: string;
}
