import { Contact, ContactStatus } from '../entities';

export type ListContactsFilter = {
  status?: ContactStatus;
  createdFrom?: Date;
  createdTo?: Date;
  page: number;
  pageSize: number;
};

export type ListContactsResult = {
  items: Contact[];
  total: number;
  page: number;
  pageSize: number;
};

export abstract class ContactsRepositoryInterface {
  abstract save(contact: Contact): Promise<void>;
  abstract update(contact: Contact): Promise<void>;
  abstract findById(id: string): Promise<Contact | null>;
  abstract list(filter: ListContactsFilter): Promise<ListContactsResult>;
}
