import { ApiProperty } from '@nestjs/swagger';
import { ArrayUnique, IsArray, IsUUID } from 'class-validator';

export class FreezeSelectionInputDto {
  @ApiProperty({
    type: [String],
    example: ['uuid-conta-1', 'uuid-conta-2'],
    description:
      'As contas que devem **ficar ativas** — não as que congelam. É a ' +
      'pergunta que a tela faz, e inverter aqui obrigaria o cliente a ' +
      'enumerar o que perde.',
  })
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  keepActiveAdAccountIds!: string[];
}

export class SeatFreezeSelectionInputDto {
  @ApiProperty({
    type: [String],
    example: ['uuid-membro-1', 'uuid-membro-2'],
    description:
      'Os membros que devem **manter acesso**. O dono não entra aqui: ele ' +
      'nunca é congelado e já ocupa um assento do plano.',
  })
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  keepActiveMembershipIds!: string[];
}
