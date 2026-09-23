import { Injectable, Logger } from '@nestjs/common';
import { JobRunsRepositoryInterface } from 'src/modules/sync/domain/ports/job-runs.repository';
import { SYNC_JOBS, SyncJobName } from 'src/modules/sync/domain/job-schedule';
import {
  WindowGap,
  expectedWindows,
  gapFor,
} from 'src/modules/sync/domain/missed-windows';

/**
 * Quanto olhar para trás, por cadência.
 *
 * Diária precisa de mais dias que horária para dizer algo: uma janela por dia
 * significa que 48 horas mostrariam no máximo duas, e duas não distinguem "o
 * agendador parou" de "a madrugada foi ruim". Uma semana mostra o padrão.
 */
const LOOKBACK_HOURS: Readonly<Record<string, number>> = {
  FIVE_MINUTES: 6,
  HOURLY: 48,
  DAILY: 24 * 7,
  MONTHLY: 0,
};

/**
 * A auditoria do próprio agendamento.
 *
 * ## O buraco que ela fecha
 *
 * O produto sabia dizer que um job falhou e que um job recusou. Não sabia dizer
 * que um job **não aconteceu** — e foi exatamente esse o defeito que custou uma
 * semana: um cron horário executando 8 vezes por dia, com todas as 8 marcadas
 * `SUCCEEDED`, e nada em lugar nenhum apontando as 16 que faltaram.
 *
 * A ausência não tem log porque ninguém a escreve. Só a comparação entre a
 * cadência declarada e o que o banco tem revela, e é isso que este serviço faz.
 *
 * ## O limite, declarado
 *
 * Ela roda pelo mesmo agendador que audita. Se o processo estiver morto na hora
 * marcada, a auditoria também não acontece — mas basta ela rodar **uma vez** no
 * período examinado para reportar todas as janelas perdidas, inclusive as das
 * horas em que ninguém estava lá. É rede de segurança, não prova formal.
 *
 * ## Por que só reporta
 *
 * Reexecutar janela perdida tem semântica própria: o `ad-scoring` das 05:30 de
 * ontem ainda significa alguma coisa às 14h de hoje? Para alguns jobs sim, para
 * outros a janela seguinte já cobre. Misturar essa decisão com a detecção
 * transformaria um diagnóstico confiável numa recuperação discutível, e a parte
 * que faltava era o diagnóstico.
 */
@Injectable()
export class ScheduleAuditService {
  private readonly logger = new Logger(ScheduleAuditService.name);

  constructor(private readonly jobRuns: JobRunsRepositoryInterface) {}

  async execute(now: Date = new Date()): Promise<WindowGap[]> {
    const gaps: WindowGap[] = [];

    for (const name of Object.keys(SYNC_JOBS) as SyncJobName[]) {
      const gap = await this.auditJob(name, now);
      if (gap) gaps.push(gap);
    }

    if (gaps.length === 0) {
      this.logger.log('schedule_audit.ok nenhuma janela perdida');
      return gaps;
    }

    /**
     * `warn`, e não `log`.
     *
     * É a exceção deliberada à regra de §8.8 — a de que a rede de segurança não
     * grita a cada passagem. Aqui ela só fala quando encontra silêncio, e
     * silêncio é precisamente o que ninguém enxerga sozinho.
     */
    for (const gap of gaps) {
      this.logger.warn(
        `schedule_audit.missed job=${gap.jobName} ` +
          `perdidas=${gap.missing}/${gap.expected} ` +
          `recentes=${gap.mostRecentMissing.join(',')}`,
      );
    }

    return gaps;
  }

  private async auditJob(
    jobName: SyncJobName,
    now: Date,
  ): Promise<WindowGap | null> {
    const { cadence } = SYNC_JOBS[jobName];
    const lookbackHours = LOOKBACK_HOURS[cadence] ?? 0;
    if (lookbackHours === 0) return null;

    const since = new Date(now.getTime() - lookbackHours * 60 * 60_000);
    const expected = expectedWindows(cadence, since, now);
    if (expected.length === 0) return null;

    const recorded = await this.jobRuns.listWindowKeysSince({ jobName, since });

    return gapFor({ jobName, expected, recorded });
  }
}
