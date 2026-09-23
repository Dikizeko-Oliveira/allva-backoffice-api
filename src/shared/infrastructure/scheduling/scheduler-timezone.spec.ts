import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEDULER_TIMEZONE } from './scheduler-timezone';

/**
 * Guards the failure mode E-13 described: a scheduled job that does not declare
 * a timezone runs in the *server's* zone, which is UTC on Render and local on a
 * developer's machine.
 *
 * A cadeia diária do v1 (sync 03:00 → waste 04:00 → recomendações 04:30 →
 * resumo 08:00) escolhia os horários como hora local, e só `daily-summary`
 * declarava zona: os outros três rodavam três horas fora e a ordem se sustentava
 * por acidente.
 *
 * **A2-S1 desmontou essa cadeia** — os três jobs saíram com as tabelas que
 * alimentavam, e A2-S3 os reconstrói com dependência resolvida por consulta a
 * `JobRun`, nunca por horário (§16.14). O que sobra aqui continua valendo para
 * todo `@Cron` novo, e é a única coisa que pega um agendamento sem zona.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

function schedulerFiles(): string[] {
  const output = execFileSync(
    'grep',
    ['-rl', '--include=*.ts', '@Cron(', join(REPO_ROOT, 'src')],
    { encoding: 'utf8' },
  );

  return output
    .split('\n')
    .filter(Boolean)
    .filter((file) => !file.endsWith('.spec.ts'));
}

/** Each `@Cron(...)` call with its full option object. */
function cronDecorators(source: string): string[] {
  return [
    ...source.matchAll(/@Cron\(([\s\S]*?)\)\s*\n\s*(?:async\s+)?\w+\(/g),
  ].map((match) => match[1]);
}

describe('scheduled jobs', () => {
  const files = schedulerFiles();

  it('finds the schedulers at all (guards the guard)', () => {
    // Se o grep parar de casar, toda asserção abaixo passa vacuamente. O piso
    // acompanha o conjunto atual: 2 depois de A2-S1 (resumo diário e coleta de
    // câmbio), e volta a subir conforme A2-S3 traz os jobs de sync.
    expect(files.length).toBeGreaterThanOrEqual(2);
  });

  it.each(files.map((file) => [file.replace(`${REPO_ROOT}/`, ''), file]))(
    '%s declares a timezone on every @Cron',
    (_label, file) => {
      const decorators = cronDecorators(readFileSync(file, 'utf8'));

      expect(decorators.length).toBeGreaterThan(0);

      for (const decorator of decorators) {
        expect(decorator).toContain('timeZone');
      }
    },
  );

  it('anchors every job to the shared constant, not a literal', () => {
    // A literal 'America/Sao_Paulo' in one file and the constant in another is
    // how the two clocks diverged in the first place.
    for (const file of files) {
      const source = readFileSync(file, 'utf8');

      for (const decorator of cronDecorators(source)) {
        expect(decorator).toContain('SCHEDULER_TIMEZONE');
      }
    }
  });

  it('resolves to a zone Node actually knows', () => {
    expect(
      () => new Intl.DateTimeFormat('pt-BR', { timeZone: SCHEDULER_TIMEZONE }),
    ).not.toThrow();
  });
});
