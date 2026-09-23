import { Injectable, NotFoundException } from '@nestjs/common';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import { ListOrganizationOutputDto } from '../dtos';
import { OrganizationUsersRepositoryInterface } from 'src/modules/organizations/domain/ports';
import { CurrentOrganizationResolver } from '../current-organization.resolver';
import { SeatLimitService } from '../services/seat-limit.service';

@Injectable()
export class ListOrganizationUseCase {
  constructor(
    private readonly currentOrganization: CurrentOrganizationResolver,
    private readonly organizationUsersRepository: OrganizationUsersRepositoryInterface,
    private readonly accountsRepository: AccountsRepositoryInterface,
    private readonly seatLimit: SeatLimitService,
  ) {}

  async execute(accountId: string): Promise<ListOrganizationOutputDto> {
    const account = await this.accountsRepository.findById(accountId);

    if (!account) {
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Account not found',
      });
    }

    const { organization } = await this.currentOrganization.resolve(accountId);

    const owner = await this.accountsRepository.findById(organization.ownerId);

    if (!owner) {
      throw new NotFoundException({
        code: 'OWNER_ACCOUNT_NOT_FOUND',
        message: 'Owner account not found',
      });
    }

    /**
     * Os assentos vêm com a lista, e não de uma rota à parte.
     *
     * É a legenda da própria lista ("2 de 10 usuários do plano"), e uma segunda
     * requisição para exibir um número ao lado de dados que já chegaram só cria
     * a janela em que os dois discordam. A contagem é a do `SeatLimitService` —
     * a mesma que recusa o próximo convite.
     */
    const [organizationUsers, seats] = await Promise.all([
      this.organizationUsersRepository.listByOrganizationId(organization.id),
      this.seatLimit.resolve(organization.id),
    ]);

    const members = await Promise.all(
      organizationUsers.map(async (organizationUser) => {
        const memberAccount = await this.accountsRepository.findById(
          organizationUser.accountId,
        );

        return {
          id: organizationUser.id,
          accountId: organizationUser.accountId,
          role: organizationUser.role,
          status: organizationUser.status,
          name: memberAccount?.name ?? '',
          email: memberAccount?.email ?? '',
          createdAt: organizationUser.createdAt,
        };
      }),
    );

    return {
      organization: {
        id: organization.id,
        ownerId: organization.ownerId,
        name: organization.name,
        cnpj: organization.cnpj,
        phone: organization.phone,
        address: organization.address,
        addressNumber: organization.addressNumber,
        addressComplement: organization.addressComplement,
        addressCity: organization.addressCity,
        createdAt: organization.createdAt,
        nameIsProvisional: organization.hasProvisionalName(),
        owner: {
          id: owner.id,
          name: owner.name,
          email: owner.email,
        },
      },
      members,
      seats,
    };
  }
}
