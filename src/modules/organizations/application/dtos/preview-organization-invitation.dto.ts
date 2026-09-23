import { ApiProperty } from '@nestjs/swagger';

/**
 * O necessário para a tela de aceite montar o link de login/cadastro com o
 * e-mail já preenchido - nada além disso. Sem papel, sem quem convidou: quem
 * ainda não provou controlar o token não precisa saber mais que isto.
 */
export class PreviewOrganizationInvitationOutputDto {
  @ApiProperty({ example: 'convidado@empresa.com' })
  email: string;

  @ApiProperty({ example: 'Acme Ltda' })
  organizationName: string;
}
