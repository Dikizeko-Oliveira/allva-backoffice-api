import { Contact } from '../domain/entities';
import { ContactOutputDto } from './dtos';

export function toContactOutput(contact: Contact): ContactOutputDto {
  return {
    id: contact.id,
    accountId: contact.accountId,
    name: contact.name,
    email: contact.email,
    subject: contact.subject,
    message: contact.message,
    company: contact.company,
    status: contact.status,
    source: contact.source,
    readAt: contact.readAt,
    repliedAt: contact.repliedAt,
    archivedAt: contact.archivedAt,
    createdAt: contact.createdAt,
    updatedAt: contact.updatedAt,
  };
}
