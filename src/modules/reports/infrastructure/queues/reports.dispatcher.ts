import { InjectQueue } from '@nestjs/bull';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bull';
import { GENERATE_REPORT_JOB, REPORTS_QUEUE } from './reports.constants';

export type GenerateReportJobData = {
  reportId: string;
};

@Injectable()
export class ReportsDispatcher {
  constructor(@InjectQueue(REPORTS_QUEUE) private readonly queue: Queue) {}

  async enqueue(data: GenerateReportJobData): Promise<string | null> {
    const job = await this.queue.add(GENERATE_REPORT_JOB, data, {
      attempts: 2,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: 100,
      removeOnFail: 200,
    });
    return job?.id ? String(job.id) : null;
  }
}
