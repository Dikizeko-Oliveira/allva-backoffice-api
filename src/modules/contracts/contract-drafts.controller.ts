import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { BackofficeAuditLogService } from '../audit/audit-log.service';
import { CurrentOperator } from '../auth/current-operator.decorator';
import { OperatorContext } from '../auth/operator-context';
import { RequirePlatformPermissions } from '../auth/require-platform-permissions.decorator';
import { normalizePage, pageResult } from '../common/pagination';
import { ProductApiClient } from '../product/product-api.client';

type ContractDraftRow = {
  id: string;
  sales_lead_id: string;
  terms: unknown;
  status: string;
  draft_document_key: string | null;
  signature_provider: string | null;
  envelope_id: string | null;
  envelope_status: string | null;
  contract_id: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
};

@Controller('contract-drafts')
export class ContractDraftsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly productApi: ProductApiClient,
    private readonly audit: BackofficeAuditLogService,
  ) {}

  @Get()
  @RequirePlatformPermissions('billing:read')
  async list(
    @Query() query: { salesLeadId?: string; page?: number; pageSize?: number },
  ) {
    const { page, pageSize, skip } = normalizePage(query);
    const rows = await this.prisma.$queryRawUnsafe<ContractDraftRow[]>(
      `
        SELECT *
        FROM contract_drafts
        WHERE ($1::text IS NULL OR sales_lead_id = $1)
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
      `,
      query.salesLeadId ?? null,
      pageSize,
      skip,
    );
    const [{ count }] = await this.prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `
        SELECT COUNT(*)::bigint AS count
        FROM contract_drafts
        WHERE ($1::text IS NULL OR sales_lead_id = $1)
      `,
      query.salesLeadId ?? null,
    );

    return pageResult(rows.map(toDraft), Number(count), page, pageSize);
  }

  @Get(':id')
  @RequirePlatformPermissions('billing:read')
  async get(@Param('id') id: string) {
    return toDraft(await this.findDraft(id));
  }

  @Post()
  @RequirePlatformPermissions('billing:manage')
  async create(
    @CurrentOperator() operator: OperatorContext,
    @Body()
    body: {
      salesLeadId: string;
      terms: unknown;
      draftDocumentKey?: string | null;
      signatureProvider?: string | null;
      envelopeId?: string | null;
      envelopeStatus?: string | null;
    },
  ) {
    const [row] = await this.prisma.$queryRaw<ContractDraftRow[]>`
      INSERT INTO contract_drafts (
        sales_lead_id, terms, draft_document_key, signature_provider,
        envelope_id, envelope_status, created_by
      )
      VALUES (
        ${body.salesLeadId},
        ${JSON.stringify(body.terms)}::jsonb,
        ${body.draftDocumentKey ?? null},
        ${body.signatureProvider ?? null},
        ${body.envelopeId ?? null},
        ${body.envelopeStatus ?? null},
        ${operator.id}
      )
      RETURNING *
    `;

    await this.audit.record({
      actor: operator,
      action: 'contract_draft.created',
      subjectType: 'CONTRACT_DRAFT',
      subjectId: row.id,
      after: toDraft(row),
    });

    return toDraft(row);
  }

  @Patch(':id')
  @RequirePlatformPermissions('billing:manage')
  async update(
    @CurrentOperator() operator: OperatorContext,
    @Param('id') id: string,
    @Body()
    body: Partial<{
      terms: unknown;
      status: string;
      draftDocumentKey: string | null;
      signatureProvider: string | null;
      envelopeId: string | null;
      envelopeStatus: string | null;
    }>,
  ) {
    const before = await this.findDraft(id);
    const [row] = await this.prisma.$queryRaw<ContractDraftRow[]>`
      UPDATE contract_drafts
      SET
        terms = CASE WHEN ${Object.hasOwn(body, 'terms')} THEN ${JSON.stringify(body.terms ?? {})}::jsonb ELSE terms END,
        status = COALESCE(${body.status ?? null}, status),
        draft_document_key = CASE WHEN ${Object.hasOwn(body, 'draftDocumentKey')} THEN ${body.draftDocumentKey ?? null} ELSE draft_document_key END,
        signature_provider = CASE WHEN ${Object.hasOwn(body, 'signatureProvider')} THEN ${body.signatureProvider ?? null} ELSE signature_provider END,
        envelope_id = CASE WHEN ${Object.hasOwn(body, 'envelopeId')} THEN ${body.envelopeId ?? null} ELSE envelope_id END,
        envelope_status = CASE WHEN ${Object.hasOwn(body, 'envelopeStatus')} THEN ${body.envelopeStatus ?? null} ELSE envelope_status END,
        updated_at = now()
      WHERE id = ${id}
      RETURNING *
    `;

    await this.audit.record({
      actor: operator,
      action: 'contract_draft.updated',
      subjectType: 'CONTRACT_DRAFT',
      subjectId: id,
      before: toDraft(before),
      after: toDraft(row),
    });

    return toDraft(row);
  }

  @Post(':id/convert')
  @RequirePlatformPermissions('billing:manage')
  async convert(
    @CurrentOperator() operator: OperatorContext,
    @Param('id') id: string,
  ) {
    const draft = await this.findDraft(id);
    if (draft.contract_id) return toDraft(draft);

    const contract = await this.productApi.request<{
      id?: string;
      contractId?: string;
    }>('/api/v1/admin/contracts', {
      method: 'POST',
      token: operator.token,
      body: draft.terms,
    });
    const contractId = contract.contractId ?? contract.id;

    const [row] = await this.prisma.$queryRaw<ContractDraftRow[]>`
      UPDATE contract_drafts
      SET status = 'SIGNED',
          contract_id = ${contractId},
          updated_at = now()
      WHERE id = ${id}
      RETURNING *
    `;

    await this.audit.record({
      actor: operator,
      action: 'contract_draft.converted',
      subjectType: 'CONTRACT_DRAFT',
      subjectId: id,
      before: toDraft(draft),
      after: toDraft(row),
    });

    return toDraft(row);
  }

  private async findDraft(id: string) {
    const [row] = await this.prisma.$queryRaw<ContractDraftRow[]>`
      SELECT * FROM contract_drafts WHERE id = ${id}
    `;
    if (!row) {
      throw new NotFoundException({
        code: 'CONTRACT_DRAFT_NOT_FOUND',
        message: 'Contract draft not found',
      });
    }
    return row;
  }
}

function toDraft(row: ContractDraftRow) {
  return {
    id: row.id,
    salesLeadId: row.sales_lead_id,
    terms: row.terms,
    status: row.status,
    draftDocumentKey: row.draft_document_key,
    signatureProvider: row.signature_provider,
    envelopeId: row.envelope_id,
    envelopeStatus: row.envelope_status,
    contractId: row.contract_id,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
