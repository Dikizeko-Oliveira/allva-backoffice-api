import { ApiProperty, OmitType } from '@nestjs/swagger';
import { IsEmail, MaxLength } from 'class-validator';
import { CreateSalesLeadInputDto } from './create-sales-lead.dto';
import { SanitizeEmail } from '../validators/sanitize.transform';

/**
 * O lead cadastrado pelo **operador**, e não pelo formulário de `/sales`.
 *
 * Mesmos campos, uma regra a menos: cai o `@IsCorporateEmail()`.
 *
 * Aquele validador existe para filtrar ruído numa porta aberta na internet —
 * `@gmail.com` num formulário público quase sempre é curioso, não comprador. Do
 * lado do operador ele vira obstáculo: um contato colhido em evento ou vindo por
 * indicação frequentemente entrega o e-mail pessoal, e recusar o cadastro faria
 * o comercial anotar o negócio fora do sistema — que é o que este endpoint
 * existe para evitar.
 *
 * A triagem, aqui, é a pessoa que está cadastrando. É por isso que a rota exige
 * papel de plataforma e a pública não exige nada.
 *
 * `OmitType` em vez de reescrever os oito campos: o formulário público continua
 * sendo a definição de quais dados um lead carrega, e uma cópia divergiria no
 * primeiro campo acrescentado a um só dos dois.
 */
export class CreateAdminSalesLeadInputDto extends OmitType(
  CreateSalesLeadInputDto,
  ['workEmail'] as const,
) {
  @ApiProperty({ example: 'contato@empresa.com.br' })
  @SanitizeEmail()
  @IsEmail({}, { message: 'Work email must be a valid email and is required' })
  @MaxLength(320, { message: 'Work email must have at most 320 characters' })
  workEmail: string;
}
