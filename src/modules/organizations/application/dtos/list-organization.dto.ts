import { ApiProperty } from '@nestjs/swagger';

class OrganizationOwnerDto {
  @ApiProperty({ example: 'uuid-owner-id' })
  id: string;

  @ApiProperty({ example: 'Owner Name' })
  name: string;

  @ApiProperty({ example: 'owner@company.com' })
  email: string;
}

class OrganizationDto {
  @ApiProperty({ example: 'uuid-organization-id' })
  id: string;

  @ApiProperty({ example: 'uuid-owner-id' })
  ownerId: string;

  @ApiProperty({ example: 'Allva LTDA' })
  name: string;

  @ApiProperty({ example: '12.345.678/0001-99', nullable: true })
  cnpj?: string;

  @ApiProperty({ example: '+55 11 99999-9999', nullable: true })
  phone?: string;

  @ApiProperty({ example: 'Av. Paulista', nullable: true })
  address?: string;

  @ApiProperty({ example: '1000', nullable: true })
  addressNumber?: string;

  @ApiProperty({ example: 'Conjunto 120', nullable: true })
  addressComplement?: string;

  @ApiProperty({ example: 'Sao Paulo', nullable: true })
  addressCity?: string;

  @ApiProperty({ example: '2026-03-15T00:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({
    example: false,
    description:
      'O nome ainda é o derivado da conta no cadastro, e ninguém o ' +
      'confirmou. A tela de convite pede o rename antes do primeiro envio — ' +
      'é o único lugar onde terceiros leem este nome ("Fulano convidou você ' +
      'para participar da organização X").',
  })
  nameIsProvisional: boolean;

  @ApiProperty({ type: OrganizationOwnerDto })
  owner: OrganizationOwnerDto;
}

class OrganizationMemberDto {
  @ApiProperty({ example: 'uuid-organization-user-id' })
  id: string;

  @ApiProperty({ example: 'uuid-account-id' })
  accountId: string;

  @ApiProperty({
    example: 'MEMBER',
    enum: ['OWNER', 'ADMIN', 'FINANCE', 'ANALYST', 'MEMBER', 'VIEWER'],
  })
  role: 'OWNER' | 'ADMIN' | 'FINANCE' | 'ANALYST' | 'MEMBER' | 'VIEWER';

  @ApiProperty({
    example: 'ACTIVE',
    enum: ['ACTIVE', 'INVITED', 'BLOCKED', 'REMOVED'],
  })
  status: 'ACTIVE' | 'INVITED' | 'BLOCKED' | 'REMOVED';

  @ApiProperty({ example: 'Member Name' })
  name: string;

  @ApiProperty({ example: 'member@company.com' })
  email: string;

  @ApiProperty({ example: '2026-03-15T00:00:00.000Z' })
  createdAt: Date;
}

/**
 * Assentos ocupados e disponíveis — os **mesmos** números que `SeatLimitService`
 * compara ao recusar um convite.
 *
 * Vem junto com os membros de propósito: é a legenda da lista que está logo
 * acima, e derivá-la de `members.length` do lado da tela contaria diferente —
 * um convite pendente ocupa assento e não aparece na lista de membros, então o
 * número exibido divergiria do número que recusa o próximo convite.
 */
class OrganizationSeatsDto {
  @ApiProperty({
    example: 10,
    nullable: true,
    description:
      'Teto efetivo: o negociado do contrato quando existe, senão o do plano. ' +
      '`null` é plano irresolúvel — **não** ilimitado; o Enterprise nomeia um ' +
      'piso desde que ilimitado deixou de existir.',
  })
  limit: number | null;

  @ApiProperty({
    example: 3,
    description:
      'Assentos ocupados: participações ACTIVE + convites pendentes.',
  })
  used: number;

  @ApiProperty({ example: 2 })
  activeMembers: number;

  @ApiProperty({
    example: 1,
    description:
      'Convites pendentes. Ocupam assento — é o que impede uma organização de ' +
      'ultrapassar o plano empilhando convites.',
  })
  pendingInvitations: number;
}

export class ListOrganizationOutputDto {
  @ApiProperty({ type: OrganizationDto })
  organization: OrganizationDto;

  @ApiProperty({ type: [OrganizationMemberDto] })
  members: OrganizationMemberDto[];

  @ApiProperty({ type: OrganizationSeatsDto })
  seats: OrganizationSeatsDto;
}
