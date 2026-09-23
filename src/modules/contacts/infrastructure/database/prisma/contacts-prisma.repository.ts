import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { Contact, ContactStatus } from '../../../domain/entities';
import {
  ListContactsFilter,
  ListContactsResult,
  ContactsRepositoryInterface,
} from '../../../domain/ports';

type ContactRow = {
  id: string;
  accountId: string | null;
  name: string;
  email: string;
  subject: string;
  message: string;
  company: string | null;
  status: string;
  source: string | null;
  readAt: Date | null;
  repliedAt: Date | null;
  archivedAt: Date | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class ContactsPrismaRepository implements ContactsRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  private toEntity(row: ContactRow): Contact {
    return Contact.restore({
      id: row.id,
      accountId: row.accountId,
      name: row.name,
      email: row.email,
      subject: row.subject,
      message: row.message,
      company: row.company,
      status: row.status as ContactStatus,
      source: row.source,
      readAt: row.readAt,
      repliedAt: row.repliedAt,
      archivedAt: row.archivedAt,
      metadata: (row.metadata as Record<string, unknown> | null) ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  async save(contact: Contact): Promise<void> {
    await this.prisma.contact.create({
      data: {
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
        metadata: contact.metadata ?? undefined,
        createdAt: contact.createdAt,
        updatedAt: contact.updatedAt,
      } as never,
    });
  }

  async update(contact: Contact): Promise<void> {
    await this.prisma.contact.update({
      where: { id: contact.id },
      data: {
        status: contact.status,
        readAt: contact.readAt,
        repliedAt: contact.repliedAt,
        archivedAt: contact.archivedAt,
        updatedAt: contact.updatedAt,
      } as never,
    });
  }

  async findById(id: string): Promise<Contact | null> {
    const record = await this.prisma.contact.findUnique({ where: { id } });
    if (!record) return null;
    return this.toEntity(record as unknown as ContactRow);
  }

  async list(filter: ListContactsFilter): Promise<ListContactsResult> {
    const where = {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.createdFrom || filter.createdTo
        ? {
            createdAt: {
              ...(filter.createdFrom ? { gte: filter.createdFrom } : {}),
              ...(filter.createdTo ? { lte: filter.createdTo } : {}),
            },
          }
        : {}),
    };

    const skip = (filter.page - 1) * filter.pageSize;

    const [records, total] = await Promise.all([
      this.prisma.contact.findMany({
        where: where as never,
        orderBy: { createdAt: 'desc' },
        skip,
        take: filter.pageSize,
      }),
      this.prisma.contact.count({ where: where as never }),
    ]);

    return {
      items: records.map((record) =>
        this.toEntity(record as unknown as ContactRow),
      ),
      total,
      page: filter.page,
      pageSize: filter.pageSize,
    };
  }
}
