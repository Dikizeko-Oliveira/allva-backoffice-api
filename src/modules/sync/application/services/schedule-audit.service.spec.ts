import { Logger } from '@nestjs/common';
import { ScheduleAuditService } from './schedule-audit.service';
import { SYNC_JOBS, SyncJobName } from 'src/modules/sync/domain/job-schedule';
import { expectedWindows } from 'src/modules/sync/domain/missed-windows';

/**
 * A auditoria do agendamento (item que fechou o buraco de observabilidade).
 *
 * O que se testa aqui não é a aritmética das janelas — isso é
 * `missed-windows.spec.ts` — e sim que ela **grita**. O defeito original
 * sobreviveu uma semana porque toda a informação relevante estava em `log`, e
 * `log` é o que ninguém lê quando nada parece errado.
 */

const NOW = new Date('2026-09-07T14:30:00.000Z');

function buildHarness(recordedByJob: Partial<Record<SyncJobName, string[]>>) {
  const jobRuns = {
    listWindowKeysSince: jest
      .fn()
      .mockImplementation(({ jobName }: { jobName: SyncJobName }) =>
        Promise.resolve(recordedByJob[jobName] ?? []),
      ),
  };

  return {
    service: new ScheduleAuditService(jobRuns as never),
    jobRuns,
    warn: jest.spyOn(Logger.prototype, 'warn').mockImplementation(),
    log: jest.spyOn(Logger.prototype, 'log').mockImplementation(),
  };
}

afterEach(() => jest.restoreAllMocks());

describe('auditoria do agendamento', () => {
  it('grita em warn quando um cron horário some do ar', async () => {
    const h = buildHarness({
      // O retrato real de staging: 8 execuções num dia. A auditoria de cadência
      // horária olha 48 horas para trás, então das 48 janelas esperadas 40
      // ficaram sem linha nenhuma.
      'ads-ingest': [
        '2026-09-07T02',
        '2026-09-07T03',
        '2026-09-07T06',
        '2026-09-07T09',
        '2026-09-06T17',
        '2026-09-06T18',
        '2026-09-06T19',
        '2026-09-06T22',
      ],
    });

    const gaps = await h.service.execute(NOW);

    const ingest = gaps.find((gap) => gap.jobName === 'ads-ingest');
    expect(ingest?.expected).toBe(48);
    expect(ingest?.missing).toBe(40);

    // O ponto do item: isto precisa ser `warn`, não `log`.
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining('schedule_audit.missed job=ads-ingest'),
    );
  });

  it('reporta o job que nunca registrou nada', async () => {
    const h = buildHarness({});

    const gaps = await h.service.execute(NOW);

    // `ads-ingest-full` é o caso que motivou tudo: zero linhas, nunca.
    const full = gaps.find((gap) => gap.jobName === 'ads-ingest-full');
    expect(full).toBeDefined();
    expect(full!.missing).toBe(full!.expected);
  });

  it('percorre todo job de cadência auditável, sem lista paralela', async () => {
    const h = buildHarness({});

    await h.service.execute(NOW);

    // A varredura sai de `SYNC_JOBS`: um job novo entra na auditoria sozinho, e
    // uma segunda lista para manter em sincronia é como a cobertura degrada.
    const auditable = (Object.keys(SYNC_JOBS) as SyncJobName[]).filter(
      (name) => SYNC_JOBS[name].cadence !== 'MONTHLY',
    );

    expect(h.jobRuns.listWindowKeysSince).toHaveBeenCalledTimes(
      auditable.length,
    );
  });

  it('não audita cadência mensal', async () => {
    const h = buildHarness({});

    const gaps = await h.service.execute(NOW);

    expect(gaps.map((gap) => gap.jobName)).not.toContain('data-retention');
  });

  it('agendamento em dia não gera um único warn', async () => {
    /**
     * O outro lado do item: uma auditoria que reclama quando está tudo certo é
     * ruído, e ruído treina a equipe a ignorar o canal — que foi exatamente
     * como as 16 janelas perdidas passaram despercebidas.
     */
    const jobRuns = {
      listWindowKeysSince: jest
        .fn()
        .mockImplementation(
          ({ jobName, since }: { jobName: SyncJobName; since: Date }) =>
            Promise.resolve(
              expectedWindows(SYNC_JOBS[jobName].cadence, since, NOW),
            ),
        ),
    };

    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();

    const gaps = await new ScheduleAuditService(jobRuns as never).execute(NOW);

    expect(gaps).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('schedule_audit.ok'),
    );
  });
});
