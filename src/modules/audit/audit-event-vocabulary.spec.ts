import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * Guards the audit vocabulary against the failure mode Sprint 5 spent an item
 * cleaning up: declared-but-unreachable code.
 *
 * `AuditEvent` is a closed union so dashboards can rely on a stable set of names.
 * That only holds if every declared name is actually emitted somewhere — an event
 * nobody records is a promise the trail does not keep, and it is invisible to the
 * type checker.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..');
const ENTITY = join(
  REPO_ROOT,
  'src/modules/audit/domain/entities/audit-log.entity.ts',
);

/** Every event name declared in the `AuditEvent` union. */
function declaredEvents(): string[] {
  /**
   * Comentários de linha saem antes do fatiamento.
   *
   * O corte vai até o primeiro `;` depois de `export type AuditEvent`, e um
   * ponto-e-vírgula escrito **dentro** de um comentário da união truncava a
   * lista — o teste reprovava com "recebido: 1" e apontava para o parser, não
   * para o comentário. Nenhum nome de evento mora em comentário, então removê-los
   * não perde nada e tira a prosa do caminho da varredura.
   */
  const source = readFileSync(ENTITY, 'utf8').replace(/\/\/.*$/gm, '');
  const union = source.slice(
    source.indexOf('export type AuditEvent'),
    source.indexOf(';', source.indexOf('export type AuditEvent')),
  );

  return [...union.matchAll(/'([a-z_]+\.[a-z_.]+)'/g)].map((m) => m[1]);
}

/**
 * Event names referenced anywhere under src/, excluding specs and the file that
 * declares the union.
 *
 * Matches any quoted occurrence rather than only `event: '...'`, because events are
 * legitimately produced by expressions — `update-organization-user-status` picks
 * between `member.removed` and `member.status.updated` with a ternary. Anchoring on
 * `event:` reported that one as an orphan when it is emitted on every call.
 */
function emittedEvents(): Set<string> {
  const output = execFileSync(
    'grep',
    [
      '-rhoE',
      "'[a-z_]+\\.[a-z_.]+'",
      join(REPO_ROOT, 'src'),
      '--include=*.ts',
      '--exclude=*.spec.ts',
      '--exclude=audit-log.entity.ts',
    ],
    { encoding: 'utf8' },
  );

  return new Set(
    output
      .split('\n')
      .map((line) => line.match(/'([^']+)'/)?.[1])
      .filter((value): value is string => Boolean(value)),
  );
}

describe('audit event vocabulary', () => {
  const declared = declaredEvents();
  const emitted = emittedEvents();

  it('declares the events the union is supposed to contain', () => {
    // Sanity check on the parsing itself, so a regex slip cannot make the real
    // assertion below pass vacuously.
    expect(declared.length).toBeGreaterThanOrEqual(20);
    expect(declared).toContain('organization.created');
    expect(declared).toContain('integration.connected');
    expect(declared).toContain('account.deleted');
  });

  it.each([
    'integration.connected',
    'integration.reconnected',
    'integration.disconnected',
    'ad_account.linked',
    'ad_account.unlinked',
    'account.created',
    'account.email_verified',
    'account.updated',
    'account.password_changed',
    'account.deleted',
  ])('M-5 event %s is actually recorded somewhere', (event) => {
    expect(emitted.has(event)).toBe(true);
  });

  /**
   * The general rule. If this fails, either wire the new event up or drop it from
   * the union — do not leave a name that nothing emits.
   */
  it('has no declared event that nothing emits', () => {
    const orphans = declared.filter((event) => !emitted.has(event));

    expect(orphans).toEqual([]);
  });
});
