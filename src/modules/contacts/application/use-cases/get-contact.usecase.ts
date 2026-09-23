import { Injectable, NotFoundException } from '@nestjs/common';
import { PlatformRoleService } from 'src/modules/accounts/application/services/platform-role.service';
import { ContactOutputDto } from '../dtos';
import { ContactsRepositoryInterface } from '../../domain/ports';
import { toContactOutput } from '../contact.presenter';

@Injectable()
export class GetContactUseCase {
  constructor(
    private readonly contactsRepository: ContactsRepositoryInterface,
    private readonly platformRole: PlatformRoleService,
  ) {}

  async execute(id: string, actorId: string): Promise<ContactOutputDto> {
    await this.platformRole.assertPermission(actorId, 'contacts:read');

    const contact = await this.contactsRepository.findById(id);

    if (!contact) {
      throw new NotFoundException({
        code: 'CONTACT_NOT_FOUND',
        message: 'Contact not found',
      });
    }

    return toContactOutput(contact);
  }
}
