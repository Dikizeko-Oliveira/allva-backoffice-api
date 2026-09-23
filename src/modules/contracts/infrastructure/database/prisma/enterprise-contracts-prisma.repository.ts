import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { selectGoverningContract } from 'src/modules/subscriptions/access/domain/governing-contract';
import {
  EnterpriseContract,
  type ContractBillingInterval,
  type ContractPaymentMethod,
  type ContractPaymentTerms,
  type ContractStatus,
  type ContractSuspensionReason,
} from 'src/modules/contracts/domain/entities';
import {
  EnterpriseContractsRepositoryInterface,
  type ContractLifecycleRef,
  type ContractLabels,
  type ContractWithoutAiBudget,
  type ListContractsFilter,
  type ListContractsResult,
} from 'src/modules/contracts/domain/ports/enterprise-contracts.repository';

/** A linha como o Prisma a devolve — `Decimal` e enums do banco. */
type ContractRow = {
  id: string;
  contractNumber: string;
  salesLeadId: string;
  organizationId: string | null;
  planId: string;
  status: string;
  startsAt: Date;
  endsAt: Date;
  billingInterval: string;
  billingAmount: unknown;
  setupFeeAmount: unknown;
  currency: string;
  paymentTerms: string;
  paymentMethod: string;
  activateOnSignature: boolean;
  gracePeriodDays: number;
  autoRenew: boolean;
  maxSeats: number | null;
  maxAdAccounts: number | null;
  maxMonitoredAds: number | null;
  maxOrganizations: number | null;
  /** `unknown` como `billingAmount`: Decimal do Prisma, convertido na leitura. */
  llmDailyBudgetBase: unknown;
  signedAt: Date;
  signedDocumentUrl: string | null;
  activatedAt: Date | null;
  canceledAt: Date | null;
  suspendedAt: Date | null;
  suspendedReason: string | null;
  renewedFromId: string | null;
};

/**
 * Os estados em que o contrato ainda governa alguma coisa.
 *
 * `CANCELED`, `EXPIRED` e `RENEWED` são história: o acesso que eles concediam
 * já acabou, e trazê-los na busca do contrato vigente faria um contrato morto
 * disputar a resposta com o que o substituiu.
 */
const LIVE_STATUSES = [
  'SIGNED',
  'PENDING_ACTIVATION',
  'ACTIVE',
  'SUSPENDED',
] as const;

@Injectable()
export class EnterpriseContractsPrismaRepository implements EnterpriseContractsRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<EnterpriseContract | null> {
    const row = await this.prisma.enterpriseContract.findUnique({
      where: { id },
    });

    return row ? this.toDomain(row as ContractRow) : null;
  }

  async findLiveByOrganizationId(
    organizationId: string,
  ): Promise<EnterpriseContract | null> {
    /**
     * Depois da primeira renovação há dois vivos ao mesmo tempo: o que está
     * correndo e o que já foi assinado para o ano seguinte. "O mais recente"
     * escolheria o que ainda não começou — a mesma regra que o resolver de
     * entitlement usa mora em `selectGoverningContract`, e as duas leituras
     * precisam concordar sobre qual contrato responde.
     */
    const live = await this.listLiveByOrganizationId(organizationId);

    return selectGoverningContract(live);
  }

  async listLiveByOrganizationId(
    organizationId: string,
  ): Promise<EnterpriseContract[]> {
    const rows = await this.prisma.enterpriseContract.findMany({
      where: {
        organizationId,
        status: { in: [...LIVE_STATUSES] },
      },
      orderBy: { startsAt: 'desc' },
      // Folga sobre a invariante de no máximo dois vivos, que a guarda de
      // sobreposição na ativação agora sustenta de fato.
      take: 5,
    });

    return rows.map((row) => this.toDomain(row as ContractRow));
  }

  /**
   * Contratos vivos sem teto de IA — o par do log `provisioning.sem_teto_de_ia`.
   *
   * `LEFT JOIN` e não `JOIN`: a organização sem linha de configuração é tão
   * "sem teto" quanto a que tem a linha com a coluna nula, e um join interno a
   * esconderia — que é exatamente o caso mais grave, porque nem o default
   * chegou nela.
   *
   * Só `ACTIVE` e `SUSPENDED`: contrato ainda não ativado não provisionou
   * organização nenhuma, e cobrar um teto de quem não tem onde gastá-lo encheria
   * a lista de linhas que não pedem ação. Suspenso entra porque volta — e volta
   * consumindo.
   */
  async findLabels(ids: string[]): Promise<Map<string, ContractLabels>> {
    if (ids.length === 0) return new Map();

    const rows = await this.prisma.enterpriseContract.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        createdAt: true,
        salesLead: { select: { companyName: true } },
        organization: { select: { name: true } },
        plan: { select: { name: true } },
      },
    });

    return new Map(
      rows.map((row) => [
        row.id,
        {
          leadCompanyName: row.salesLead.companyName,
          organizationName: row.organization?.name ?? null,
          planName: row.plan.name,
          createdAt: row.createdAt,
        },
      ]),
    );
  }

  async listWithoutAiBudget(): Promise<ContractWithoutAiBudget[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        contract_id: string;
        number: string;
        status: string;
        organization_id: string;
        organization_name: string;
        activated_at: Date | null;
        max_monitored_ads: number | null;
      }>
    >`
      SELECT
        c."id"                AS contract_id,
        c."contract_number"   AS number,
        c."status"::text      AS status,
        o."id"                AS organization_id,
        o."name"              AS organization_name,
        c."activated_at"      AS activated_at,
        q."max_monitored_ads" AS max_monitored_ads
      FROM "enterprise_contracts" c
      JOIN "organizations" o ON o."id" = c."organization_id"
      LEFT JOIN "organization_ads_settings" s ON s."organization_id" = o."id"
      LEFT JOIN "organization_quotas" q ON q."organization_id" = o."id"
      WHERE c."status" IN ('ACTIVE', 'SUSPENDED')
        AND o."deleted_at" IS NULL
        AND s."llm_daily_budget_base" IS NULL
      ORDER BY c."activated_at" DESC NULLS LAST
    `;

    return rows.map((row) => ({
      contractId: row.contract_id,
      number: row.number,
      status: row.status,
      organizationId: row.organization_id,
      organizationName: row.organization_name,
      activatedAt: row.activated_at,
      maxMonitoredAds: row.max_monitored_ads,
    }));
  }

  async list(filter: ListContractsFilter): Promise<ListContractsResult> {
    const where = {
      ...(filter.status ? { status: filter.status as never } : {}),
      ...(filter.organizationId
        ? { organizationId: filter.organizationId }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.enterpriseContract.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (filter.page - 1) * filter.pageSize,
        take: filter.pageSize,
      }),
      this.prisma.enterpriseContract.count({ where }),
    ]);

    return {
      items: rows.map((row) => this.toDomain(row as ContractRow)),
      total,
      page: filter.page,
      pageSize: filter.pageSize,
    };
  }

  async save(contract: EnterpriseContract): Promise<void> {
    await this.prisma.enterpriseContract.create({
      data: this.toRow(contract),
    });
  }

  async update(contract: EnterpriseContract): Promise<void> {
    await this.prisma.enterpriseContract.update({
      where: { id: contract.id },
      data: this.toRow(contract),
    });
  }

  async nextContractNumber(year: number): Promise<string> {
    const prefix = `ENT-${year}-`;

    const last = await this.prisma.enterpriseContract.findFirst({
      where: { contractNumber: { startsWith: prefix } },
      orderBy: { contractNumber: 'desc' },
      select: { contractNumber: true },
    });

    const sequence = last
      ? Number.parseInt(last.contractNumber.slice(prefix.length), 10) + 1
      : 1;

    return `${prefix}${String(sequence).padStart(4, '0')}`;
  }

  async listLive(now: Date, limit: number): Promise<ContractLifecycleRef[]> {
    const rows = await this.prisma.enterpriseContract.findMany({
      where: { status: { in: ['ACTIVE', 'SUSPENDED'] } },
      select: {
        id: true,
        organizationId: true,
        status: true,
        startsAt: true,
        endsAt: true,
        gracePeriodDays: true,
        renewedInto: { select: { id: true } },
        invoices: {
          where: { status: { in: ['PENDING', 'FAILED'] } },
          orderBy: { dueAt: 'asc' },
          select: { dueAt: true },
          take: 1,
        },
      },
      // O mais antigo primeiro: uma carteira maior que o limite tem de escoar,
      // e não ficar revisitando os mesmos contratos a cada passada.
      orderBy: { endsAt: 'asc' },
      take: limit,
    });

    return rows.map((row) => ({
      id: row.id,
      organizationId: row.organizationId,
      status: row.status,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      gracePeriodDays: row.gracePeriodDays,
      oldestUnpaidDueAt: row.invoices[0]?.dueAt ?? null,
      hasSuccessor: row.renewedInto !== null,
    }));
  }

  private toRow(contract: EnterpriseContract) {
    return {
      id: contract.id,
      contractNumber: contract.contractNumber,
      salesLeadId: contract.salesLeadId,
      organizationId: contract.organizationId,
      planId: contract.planId,
      status: contract.status as never,
      startsAt: contract.startsAt,
      endsAt: contract.endsAt,
      billingInterval: contract.billingInterval as never,
      billingAmount: contract.billingAmount,
      setupFeeAmount: contract.setupFeeAmount,
      currency: contract.currency,
      paymentTerms: contract.paymentTerms as never,
      paymentMethod: contract.paymentMethod as never,
      activateOnSignature: contract.activateOnSignature,
      gracePeriodDays: contract.gracePeriodDays,
      autoRenew: contract.autoRenew,
      maxSeats: contract.limits.maxSeats,
      maxAdAccounts: contract.limits.maxAdAccounts,
      maxMonitoredAds: contract.limits.maxMonitoredAds,
      maxOrganizations: contract.limits.maxOrganizations,
      llmDailyBudgetBase: contract.limits.llmDailyBudgetBase,
      signedAt: contract.signedAt,
      signedDocumentUrl: contract.signedDocumentUrl,
      activatedAt: contract.activatedAt,
      canceledAt: contract.canceledAt,
      suspendedAt: contract.suspendedAt,
      suspendedReason: contract.suspendedReason as never,
      renewedFromId: contract.renewedFromId,
    };
  }

  private toDomain(row: ContractRow): EnterpriseContract {
    return EnterpriseContract.restore({
      id: row.id,
      contractNumber: row.contractNumber,
      salesLeadId: row.salesLeadId,
      organizationId: row.organizationId,
      planId: row.planId,
      status: row.status as ContractStatus,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      billingInterval: row.billingInterval as ContractBillingInterval,
      billingAmount: Number(row.billingAmount),
      setupFeeAmount:
        row.setupFeeAmount === null ? null : Number(row.setupFeeAmount),
      currency: row.currency,
      paymentTerms: row.paymentTerms as ContractPaymentTerms,
      paymentMethod: row.paymentMethod as ContractPaymentMethod,
      activateOnSignature: row.activateOnSignature,
      gracePeriodDays: row.gracePeriodDays,
      autoRenew: row.autoRenew,
      limits: {
        maxSeats: row.maxSeats,
        maxAdAccounts: row.maxAdAccounts,
        maxMonitoredAds: row.maxMonitoredAds,
        maxOrganizations: row.maxOrganizations,
        // Decimal vira número aqui, como `billingAmount` logo acima: quem
        // consome o teto compara com dinheiro gasto, não com um objeto.
        llmDailyBudgetBase:
          row.llmDailyBudgetBase === null ||
          row.llmDailyBudgetBase === undefined
            ? null
            : Number(row.llmDailyBudgetBase),
      },
      signedAt: row.signedAt,
      signedDocumentUrl: row.signedDocumentUrl,
      activatedAt: row.activatedAt,
      canceledAt: row.canceledAt,
      suspendedAt: row.suspendedAt,
      suspendedReason: row.suspendedReason as ContractSuspensionReason | null,
      renewedFromId: row.renewedFromId,
    });
  }
}
