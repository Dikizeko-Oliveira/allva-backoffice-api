export type ReportStatus = 'PENDING' | 'GENERATING' | 'READY' | 'FAILED';

export type ReportInput = {
  accountId: string;
  organizationId?: string | null;
  templateKey: string;
  params?: Record<string, unknown> | null;
};

export type ReportDTO = {
  id: string;
  accountId: string;
  organizationId: string | null;
  templateKey: string;
  status: ReportStatus;
  params: Record<string, unknown> | null;
  storageProvider: string | null;
  storageKey: string | null;
  downloadUrl: string | null;
  errorMessage: string | null;
  generatedAt: Date | null;
  emailedAt: Date | null;
  createdAt: Date;
};

export abstract class ReportsRepositoryInterface {
  abstract create(input: ReportInput): Promise<ReportDTO>;
  abstract findById(
    id: string,
    scope: { accountId: string; organizationId?: string | null },
  ): Promise<ReportDTO | null>;
  abstract findByIdInternal(id: string): Promise<ReportDTO | null>;
  abstract list(scope: {
    accountId: string;
    organizationId?: string | null;
  }): Promise<ReportDTO[]>;
  abstract updateStatus(
    id: string,
    status: ReportStatus,
    options?: {
      storageProvider?: string | null;
      storageKey?: string | null;
      downloadUrl?: string | null;
      errorMessage?: string | null;
    },
  ): Promise<ReportDTO>;
  abstract markEmailed(id: string): Promise<ReportDTO>;
}
