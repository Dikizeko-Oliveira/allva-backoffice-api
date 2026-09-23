import { ApiProperty } from '@nestjs/swagger';

/**
 * A recusa por teto de organizações, **antes** de o formulário existir.
 *
 * Mesma decisão que `POST /organizations` aplica, na forma de leitura: os
 * campos espelham `details` de `PLAN_FEATURE_NOT_INCLUDED` de propósito, para a
 * tela mostrar a mesma frase antes e depois de tentar.
 */
export class OrganizationCreationAllowanceOutputDto {
  @ApiProperty({
    example: false,
    description:
      'A conta pode possuir mais uma organização. É o veredito da mesma ' +
      'guarda que `POST /organizations` aplica — não uma estimativa.',
  })
  allowed: boolean;

  @ApiProperty({
    example: 1,
    description: 'Organizações que a conta já **possui** (`ownerId`).',
  })
  used: number;

  @ApiProperty({
    example: 1,
    nullable: true,
    description:
      'Teto efetivo: o negociado do contrato quando existe, senão o do plano. ' +
      '`null` é ausência de teto a aplicar — ilimitado, ou conta sem ' +
      'organização de referência de onde ler contrato.',
  })
  limit: number | null;

  @ApiProperty({
    example: 'Profissional',
    nullable: true,
    description:
      'Nome comercial do plano vigente, para a tela dizer o que se tem. Nulo ' +
      'enquanto não há organização de referência.',
  })
  planLabel: string | null;

  @ApiProperty({
    example: 'Enterprise',
    nullable: true,
    description:
      'O plano contratável mais barato que oferece **mais** que o teto atual — ' +
      'para onde apontar. Nulo quando não há recusa a remediar ou quando só o ' +
      'comercial resolve.',
  })
  upgradeTo: string | null;
}
