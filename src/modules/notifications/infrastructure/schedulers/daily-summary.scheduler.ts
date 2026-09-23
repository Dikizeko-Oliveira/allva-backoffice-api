import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DailySummaryService } from 'src/modules/notifications/application/services/daily-summary.service';
import { SCHEDULER_TIMEZONE } from 'src/shared/infrastructure/scheduling/scheduler-timezone';

@Injectable()
export class DailySummaryScheduler {
  private readonly logger = new Logger(DailySummaryScheduler.name);

  constructor(private readonly dailySummary: DailySummaryService) {}

  @Cron('0 8 * * *', {
    name: 'daily-summary',
    timeZone: SCHEDULER_TIMEZONE,
  })
  async run(): Promise<void> {
    this.logger.log('Daily summary scheduler triggered');
    const result = await this.dailySummary.sendForAll();
    this.logger.log(
      `Daily summary finished: sent=${result.sent} skipped=${result.skipped} errors=${result.errors}`,
    );
  }
}
