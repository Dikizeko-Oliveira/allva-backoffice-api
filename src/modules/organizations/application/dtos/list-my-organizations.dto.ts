import { ApiProperty } from '@nestjs/swagger';

export class ListMyOrganizationsItemDto {
  @ApiProperty({ example: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Franquia Zona Sul' })
  name: string;

  @ApiProperty({
    example: true,
    description: 'A conta criou esta organização (`ownerId`).',
  })
  isOwner: boolean;

  @ApiProperty({
    example: 'OWNER',
    nullable: true,
    description:
      'Papel na organização. Nulo quando a conta é dona mas não tem ' +
      'participação ativa — estado degradado, listado assim mesmo para ela ' +
      'não perder acesso à própria organização pela tela.',
  })
  role: string | null;

  @ApiProperty({
    example: 'ALLOWED',
    description:
      'Acesso ao produto **nesta** organização. `ALLOWED` e `GRACE_PERIOD` ' +
      'entram; o resto vê a tela de planos. O seletor é a única rota que ' +
      'responde fora do teto — é por ela que quem tem uma organização vencida ' +
      'e outra em dia troca para a que está em dia.',
  })
  accessStatus: string;
}
