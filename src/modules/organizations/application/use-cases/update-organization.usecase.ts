import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import {
  UpdateOrganizationInputDto,
  UpdateOrganizationOutputDto,
} from '../dtos';
import { OrganizationsRepositoryInterface } from 'src/modules/organizations/domain/ports';
import { CurrentOrganizationResolver } from '../current-organization.resolver';

@Injectable()
export class UpdateOrganizationUseCase {
  constructor(
    private readonly organizationsRepository: OrganizationsRepositoryInterface,
    private readonly currentOrganization: CurrentOrganizationResolver,
  ) {}

  async execute(
    input: UpdateOrganizationInputDto,
    ownerId: string,
  ): Promise<UpdateOrganizationOutputDto> {
    const current = await this.currentOrganization.resolve(ownerId);
    const organization = current.organization;

    // Resolution alone no longer implies the right to edit: with the header
    // honoured, a MEMBER of the selected organization reaches this point too.
    // Previously only an owner could resolve one at all, so the check was implicit.
    if (!this.currentOrganization.canManageMembers(current)) {
      throw new ForbiddenException({
        code: 'NOT_ALLOWED_TO_UPDATE_ORGANIZATION',
        message: 'Only owner or manager members can update the organization',
      });
    }

    if (
      input.name === undefined &&
      input.cnpj === undefined &&
      input.phone === undefined &&
      input.address === undefined &&
      input.addressNumber === undefined &&
      input.addressComplement === undefined &&
      input.addressCity === undefined
    ) {
      throw new BadRequestException({
        code: 'NO_FIELDS_TO_UPDATE',
        message: 'At least one field must be informed to update organization',
      });
    }

    organization.update({
      name: input.name,
      cnpj: input.cnpj,
      phone: input.phone,
      address: input.address,
      addressNumber: input.addressNumber,
      addressComplement: input.addressComplement,
      addressCity: input.addressCity,
    });

    await this.organizationsRepository.update(organization);

    return {};
  }
}
