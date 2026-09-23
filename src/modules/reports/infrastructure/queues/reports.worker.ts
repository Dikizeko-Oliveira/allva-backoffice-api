import { Process, Processor } from '@nestjs/bull';
import { Inject, Logger } from '@nestjs/common';
import { Job } from 'bull';
import { ReportsRepositoryInterface } from 'src/modules/reports/domain/ports/reports.repository';
import { ReportBuilderService } from 'src/modules/reports/application/services/report-builder.service';
import { PdfRendererService } from 'src/modules/reports/infrastructure/pdf/pdf-renderer.service';
import { StoragePortInterface } from 'src/shared/application/ports/storage.port';
import { GENERATE_REPORT_JOB, REPORTS_QUEUE } from './reports.constants';
import type { GenerateReportJobData } from './reports.dispatcher';

@Processor(REPORTS_QUEUE)
export class ReportsWorker {
  private readonly logger = new Logger(ReportsWorker.name);

  constructor(
    private readonly repo: ReportsRepositoryInterface,
    private readonly builder: ReportBuilderService,
    private readonly renderer: PdfRendererService,
    @Inject(StoragePortInterface)
    private readonly storage: StoragePortInterface,
  ) {}

  @Process(GENERATE_REPORT_JOB)
  async handle(job: Job<GenerateReportJobData>) {
    const { reportId } = job.data;
    this.logger.log(`Generating report ${reportId}`);
    const report = await this.repo.findByIdInternal(reportId);
    if (!report) {
      this.logger.warn(`Report ${reportId} not found`);
      return;
    }

    await this.repo.updateStatus(reportId, 'GENERATING');
    try {
      if (!this.builder.isValidTemplate(report.templateKey)) {
        throw new Error(`Unknown template ${report.templateKey}`);
      }
      // `params` só carrega `periodDays`, e só o modelo de período o lê - a
      // janela dos outros quatro é a da organização, lida pelo builder. O que
      // chega aqui já passou pela validação de `GenerateReportUseCase`.
      const doc = await this.builder.build(
        report.templateKey,
        {
          accountId: report.accountId,
          organizationId: report.organizationId,
        },
        report.params,
      );
      const buffer = await this.renderer.render(doc);
      const filename = `${report.templateKey}-${reportId}.pdf`;
      const uploaded = await this.storage.upload(
        buffer,
        filename,
        'application/pdf',
        'reports',
      );
      await this.repo.updateStatus(reportId, 'READY', {
        // Quem de fato guardou o PDF, não um literal. A coluna existe para dizer
        // onde procurar o objeto depois; fixa em `s3`, ela passaria a mentir no
        // instante em que `STORAGE_PROVIDER` mudasse — e mentiria só para as
        // linhas novas, deixando a tabela com duas verdades e nenhuma marca.
        storageProvider: this.storage.provider,
        storageKey: uploaded.key,
        downloadUrl: uploaded.url,
      });
      this.logger.log(`Report ${reportId} READY (${uploaded.key})`);
    } catch (err) {
      this.logger.error(`Report ${reportId} failed: ${(err as Error).message}`);
      await this.repo.updateStatus(reportId, 'FAILED', {
        errorMessage: (err as Error).message,
      });
      throw err;
    }
  }
}
