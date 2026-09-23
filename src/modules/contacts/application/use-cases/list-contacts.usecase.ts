import { Injectable } from '@nestjs/common';
import { PlatformRoleService } from 'src/modules/accounts/application/services/platform-role.service';
import { ListContactsOutputDto, ListContactsQueryDto } from '../dtos';
import { ContactsRepositoryInterface } from '../../domain/ports';
import { ContactStatus } from '../../domain/entities';
import { toContactOutput } from '../contact.presenter';

@Injectable()
export class ListContactsUseCase {
  constructor(
    private readonly contactsRepository: ContactsRepositoryInterface,
    private readonly platformRole: PlatformRoleService,
  ) {}

  async execute(
    query: ListContactsQueryDto,
    actorId: string,
  ): Promise<ListContactsOutputDto> {
    await this.platformRole.assertPermission(actorId, 'contacts:read');

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const result = await this.contactsRepository.list({
      status: query.status as ContactStatus | undefined,
      createdFrom: query.createdFrom,
      createdTo: query.createdTo,
      page,
      pageSize,
    });

    return {
      items: result.items.map(toContactOutput),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    };
  }
}
