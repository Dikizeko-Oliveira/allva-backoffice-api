import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AnalysisScopeService } from 'src/modules/analysis-scope/application/analysis-scope.service';
import { SCHEDULER_TIMEZONE } from 'src/shared/infrastructure/scheduling/scheduler-timezone';

/**
 * 05:00 — **antes** de `ad-scoring` (05:30) e de `waste` (06:00).
 *
 * A ordem é o ponto inteiro: os dois motores leem o carimbo que esta corrida
 * grava, e rodar depois deles faria a régua da noite valer só na noite seguinte.
 */
@Injectable()
export class AnalysisScopeScheduler {
  constructor(private readonly scope: AnalysisScopeService) {}

  @Cron('0 5 * * *', { name: 'analysis-scope', timeZone: SCHEDULER_TIMEZONE })
  async run(): Promise<void> {
    await this.scope.execute();
  }
}
