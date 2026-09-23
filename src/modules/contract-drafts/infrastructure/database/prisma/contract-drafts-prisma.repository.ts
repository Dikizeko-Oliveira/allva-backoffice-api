import { Injectable } from '@nestjs/common';
import type { ContractDraft as ContractDraftRecord } from 'generated/prisma/client';
import { ContractDraft } from 'src/modules/contract-drafts/domain/entities';
import {
  ContractDraftsRepositoryInterface,
  ListContractDraftsFilter,
} from 'src/modules/contract-drafts/domain/ports';
import {
  offsetOf,
  PageParams,
  PageResult,
} from 'src/shared/domain/repositories/pagination';
import { toPrismaJson } from 'src/shared/infrastructure/database/prisma/json';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

@Injectable()
export class ContractDraftsPrismaRepository implements ContractDraftsRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  async save(draft: ContractDraft): Promise<void> {
    await this.prisma.contractDraft.create({
      data: {
        id: draft.id,
        salesLeadId: draft.salesLeadId,
        createdBy: draft.createdBy,
        createdAt: draft.createdAt,
        ...toData(draft),
      },
    });
  }

  async update(draft: ContractDraft): Promise<void> {
    await this.prisma.contractDraft.update({
      where: { id: draft.id },
      data: toData(draft),
    });
  }

  async findById(id: string): Promise<ContractDraft | null> {
    const record = await this.prisma.contractDraft.findUnique({
      where: { id },
    });
    return record ? toEntity(record) : null;
  }

  async list(
    filter: ListContractDraftsFilter,
    page: PageParams,
  ): Promise<PageResult<ContractDraft>> {
    const where = { salesLeadId: filter.salesLeadId };

    const [records, total] = await Promise.all([
      this.prisma.contractDraft.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offsetOf(page),
        take: page.pageSize,
      }),
      this.prisma.contractDraft.count({ where }),
    ]);

    return { items: records.map(toEntity), total, ...page };
  }
}

function toData(draft: ContractDraft) {
  return {
    terms: toPrismaJson(draft.terms),
    status: draft.status,
    draftDocumentKey: draft.draftDocumentKey,
    signatureProvider: draft.signatureProvider,
    envelopeId: draft.envelopeId,
    envelopeStatus: draft.envelopeStatus,
    contractId: draft.contractId,
    updatedAt: draft.updatedAt,
  };
}

function toEntity(record: ContractDraftRecord): ContractDraft {
  return ContractDraft.restore({
    id: record.id,
    salesLeadId: record.salesLeadId,
    terms: record.terms,
    status: record.status,
    draftDocumentKey: record.draftDocumentKey,
    signatureProvider: record.signatureProvider,
    envelopeId: record.envelopeId,
    envelopeStatus: record.envelopeStatus,
    contractId: record.contractId,
    createdBy: record.createdBy,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}
