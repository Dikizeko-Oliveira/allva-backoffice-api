import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Webhooks must never be rate limited (PLAN.md §2.3).
 *
 * Stripe owns the subscription lifecycle: payments, renewals, cancellations,
 * expiry, upgrades and downgrades all arrive here as webhook events. A 429 does
 * not shed load, it drops a lifecycle transition — Stripe retries with backoff and,
 * once retries run out, local billing state diverges from the provider's with no
 * error anywhere. The same reasoning applies to any provider webhook added later.
 *
 * This guards the convention structurally, because the failure is silent: bare
 * `@SkipThrottle()` skips only a throttler named `default`, which this app does not
 * define, so the decorator *looks* right while doing nothing.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');

function controllerFiles(): string[] {
  const output = execFileSync(
    'grep',
    [
      '-rl',
      '--include=*.controller.ts',
      '@Controller(',
      join(REPO_ROOT, 'src'),
    ],
    { encoding: 'utf8' },
  );

  return output
    .split('\n')
    .filter(Boolean)
    .filter((file) => !file.endsWith('.spec.ts'));
}

const ROUTE_DECORATOR =
  /^\s*@(?:Post|Get|Put|Patch|Delete)\(\s*['"`]([^'"`]*)['"`]/;

/**
 * Route handlers whose path looks like a webhook, paired with the decorators that
 * follow them (Nest allows them in any order, and this file's convention is to put
 * the throttling decorator right after the verb).
 *
 * Deliberately line-based. A single regex over the whole file needed nested
 * quantifiers to span multi-line decorators, which backtracks catastrophically —
 * the first version of this guard hung the suite instead of failing it.
 */
function webhookHandlers(
  source: string,
): Array<{ route: string; decorators: string }> {
  const lines = source.split('\n');
  const handlers: Array<{ route: string; decorators: string }> = [];

  lines.forEach((line, index) => {
    const route = ROUTE_DECORATOR.exec(line)?.[1];
    if (!route?.toLowerCase().includes('webhook')) return;

    // The decorator block around the route: from the preceding blank line down to
    // the handler signature — the first line that is neither a decorator nor a
    // comment. Comments have to be skipped rather than treated as the end, since
    // decorators here carry multi-line explanations between them.
    let start = index;
    while (start > 0 && lines[start - 1].trim() !== '') start -= 1;

    const isDecoratorOrComment = (line: string) =>
      /^\s*(@|\/\*|\*|\/\/)/.test(line);

    let end = index;
    while (end + 1 < lines.length && isDecoratorOrComment(lines[end + 1])) {
      end += 1;
    }

    handlers.push({
      route,
      decorators: lines.slice(start, end + 1).join('\n'),
    });
  });

  return handlers;
}

describe('webhook routes', () => {
  const files = controllerFiles();

  it('finds the controllers at all (guards the guard)', () => {
    // If the grep stops matching, every assertion below passes vacuously.
    expect(files.length).toBeGreaterThanOrEqual(20);
  });

  const found = files.flatMap((file) =>
    webhookHandlers(readFileSync(file, 'utf8')).map((handler) => ({
      ...handler,
      file: file.replace(`${REPO_ROOT}/`, ''),
    })),
  );

  it('finds at least the Stripe webhook', () => {
    expect(found.length).toBeGreaterThanOrEqual(1);
  });

  it.each(found.map((h) => [`${h.file} → ${h.route}`, h]))(
    '%s is exempt from every throttling policy',
    (_label, handler) => {
      expect(handler.decorators).toContain('@NoThrottle()');
    },
  );

  it.each(found.map((h) => [`${h.file} → ${h.route}`, h]))(
    '%s does not rely on a bare @SkipThrottle()',
    (_label, handler) => {
      // @SkipThrottle() with no argument targets the throttler named `default`.
      // There is none, so it would exempt the route from nothing at all.
      expect(handler.decorators).not.toMatch(/@SkipThrottle\(\s*\)/);
    },
  );
});

describe('the health probe', () => {
  it('is exempt from every throttling policy', () => {
    // The load balancer probes it and reacts to the HTTP status (runbook). A 429
    // reads as unhealthy, so throttling would pull a healthy instance out of
    // rotation and push its traffic onto the ones still standing.
    const source = readFileSync(
      join(REPO_ROOT, 'src/modules/health/health.controller.ts'),
      'utf8',
    );

    expect(source).toContain('@NoThrottle()');
  });
});
