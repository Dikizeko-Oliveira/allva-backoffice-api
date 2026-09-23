import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { ContractAmendment } from 'src/modules/contracts/domain/entities';
import {
  ContractAmendmentsRepositoryInterface,
  type DueAmendmentRef,
} from 'src/modules/contracts/domain/ports/contract-amendments.repository';

/** A linha como o Prisma a devolve — `Decimal` no valor negociado. */
type AmendmentRow = {
  id: string;
  contractId: string;
  organizationId: string;
  number: string;
  effectiveAt: Date;
  appliedAt: Date | null;
  reason: string;
  billingAmount: unknown;
  maxSeats: number | null;
  maxAdAccounts: number | null;
  maxMonitoredAds: number | null;
  maxOrganizations: number | null;
  /** Decimal do Prisma, convertido por `toNumber` como `billingAmount`. */
  llmDailyBudgetBase: unknown;
  previousLlmDailyBudgetBase: unknown;
  previousBillingAmount: unknown;
  previousMaxSeats: number | null;
  previousMaxAdAccounts: number | null;
  previousMaxMonitoredAds: number | null;
  previousMaxOrganizations: number | null;
  createdBy: string;
  createdAt: Date;
};

@Injectable()
export class ContractAmendmentsPrismaRepository implements ContractAmendmentsRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<ContractAmendment | null> {
    const row = await this.prisma.contractAmendment.findUnique({
      where: { id },
    });

    return row ? this.toDomain(row) : null;
  }

  async listByContractId(contractId: string): Promise<ContractAmendment[]> {
    const rows = await this.prisma.contractAmendment.findMany({
      where: { contractId },
      orderBy: { effectiveAt: 'asc' },
    });

    return rows.map((row) => this.toDomain(row));
  }

  async save(amendment: ContractAmendment): Promise<void> {
    await this.prisma.contractAmendment.create({
      data: this.toRow(amendment),
    });
  }

  async update(amendment: ContractAmendment): Promise<void> {
    await this.prisma.contractAmendment.update({
      where: { id: amendment.id },
      data: this.toRow(amendment),
    });
  }

  async listDue(now: Date, limit: number): Promise<DueAmendmentRef[]> {
    const rows = await this.prisma.contractAmendment.findMany({
      where: { appliedAt: null, effectiveAt: { lte: now } },
      // O mais antigo primeiro: dois aditivos sobre o mesmo teto têm de ser
      // aplicados na ordem em que foram negociados, ou o "antes" carimbado
      // descreve um estado que nunca existiu.
      orderBy: { effectiveAt: 'asc' },
      select: { id: true, contractId: true, organizationId: true },
      take: limit,
    });

    return rows.map((row) => ({
      amendmentId: row.id,
      contractId: row.contractId,
      organizationId: row.organizationId,
    }));
  }

  async nextAmendmentNumber(
    contractId: string,
    contractNumber: string,
  ): Promise<string> {
    const count = await this.prisma.contractAmendment.count({
      where: { contractId },
    });

    return `${contractNumber}/A${count + 1}`;
  }

  private toRow(amendment: ContractAmendment) {
    const { changes, previous } = amendment;

    return {
      id: amendment.id,
      contractId: amendment.contractId,
      organizationId: amendment.organizationId,
      number: amendment.number,
      effectiveAt: amendment.effectiveAt,
      appliedAt: amendment.appliedAt,
      reason: amendment.reason,
      billingAmount: changes.billingAmount,
      maxSeats: changes.maxSeats,
      maxAdAccounts: changes.maxAdAccounts,
      maxMonitoredAds: changes.maxMonitoredAds,
      maxOrganizations: changes.maxOrganizations,
      llmDailyBudgetBase: changes.llmDailyBudgetBase,
      previousBillingAmount: previous.billingAmount,
      previousMaxSeats: previous.maxSeats,
      previousMaxAdAccounts: previous.maxAdAccounts,
      previousMaxMonitoredAds: previous.maxMonitoredAds,
      previousMaxOrganizations: previous.maxOrganizations,
      previousLlmDailyBudgetBase: previous.llmDailyBudgetBase,
      createdBy: amendment.createdBy,
      createdAt: amendment.createdAt,
    };
  }

  private toDomain(row: AmendmentRow): ContractAmendment {
    return ContractAmendment.restore({
      id: row.id,
      contractId: row.contractId,
      organizationId: row.organizationId,
      number: row.number,
      effectiveAt: row.effectiveAt,
      appliedAt: row.appliedAt,
      reason: row.reason,
      changes: {
        billingAmount: this.toNumber(row.billingAmount),
        maxSeats: row.maxSeats,
        maxAdAccounts: row.maxAdAccounts,
        maxMonitoredAds: row.maxMonitoredAds,
        maxOrganizations: row.maxOrganizations,
        llmDailyBudgetBase: this.toNumber(row.llmDailyBudgetBase),
      },
      previous: {
        billingAmount: this.toNumber(row.previousBillingAmount),
        maxSeats: row.previousMaxSeats,
        maxAdAccounts: row.previousMaxAdAccounts,
        maxMonitoredAds: row.previousMaxMonitoredAds,
        maxOrganizations: row.previousMaxOrganizations,
        llmDailyBudgetBase: this.toNumber(row.previousLlmDailyBudgetBase),
      },
      createdBy: row.createdBy,
      createdAt: row.createdAt,
    });
  }

  private toNumber(value: unknown): number | null {
    return value === null || value === undefined ? null : Number(value);
  }
}
