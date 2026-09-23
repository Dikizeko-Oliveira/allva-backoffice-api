import { Injectable, NotFoundException } from '@nestjs/common';
import { PlatformRoleService } from 'src/modules/accounts/application/services/platform-role.service';
import {
  UpdateContactStatusInputDto,
  UpdateContactStatusOutputDto,
} from '../dtos';
import { ContactsRepositoryInterface } from '../../domain/ports';
import { ContactStatus } from '../../domain/entities';

@Injectable()
export class UpdateContactStatusUseCase {
  constructor(
    private readonly contactsRepository: ContactsRepositoryInterface,
    private readonly platformRole: PlatformRoleService,
  ) {}

  async execute(
    id: string,
    input: UpdateContactStatusInputDto,
    actorId: string,
  ): Promise<UpdateContactStatusOutputDto> {
    // Antes de procurar o contato: um 404 para quem não tem permissão diria
    // que o id existe ou não, e a caixa de fale-conosco não é de quem chama.
    await this.platformRole.assertPermission(actorId, 'contacts:manage');

    const contact = await this.contactsRepository.findById(id);

    if (!contact) {
      throw new NotFoundException({
        code: 'CONTACT_NOT_FOUND',
        message: 'Contact not found',
      });
    }

    contact.changeStatus(input.status as ContactStatus);

    await this.contactsRepository.update(contact);

    return { id: contact.id, status: contact.status };
  }
}
