import { Injectable } from '@nestjs/common';
import { CreateContactInputDto, CreateContactOutputDto } from '../dtos';
import { Contact } from '../../domain/entities';
import { ContactsRepositoryInterface } from '../../domain/ports';

@Injectable()
export class CreateContactUseCase {
  constructor(
    private readonly contactsRepository: ContactsRepositoryInterface,
  ) {}

  /**
   * Creates a contact message. The accountId is resolved by the backend from the
   * authenticated session (or null for anonymous senders) and is never taken
   * from the request body.
   */
  async execute(
    input: CreateContactInputDto,
    accountId: string | null,
  ): Promise<CreateContactOutputDto> {
    const contact = Contact.create({
      accountId,
      name: input.name,
      email: input.email,
      subject: input.subject,
      message: input.message,
      company: input.company,
      source: input.source,
    });

    await this.contactsRepository.save(contact);

    return { id: contact.id, status: contact.status };
  }
}
