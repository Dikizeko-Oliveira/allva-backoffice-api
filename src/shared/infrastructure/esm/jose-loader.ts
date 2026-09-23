type JoseModule = typeof import('jose');

/**
 * `jose` v6 is ESM-only. Under CommonJS output TypeScript would downlevel a
 * dynamic `import()` into `require()`, which throws `ERR_REQUIRE_ESM` at
 * runtime; `new Function` keeps it a real dynamic import. The argument is a
 * compile-time constant with no interpolation, so this is module interop, not
 * eval.
 */
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const importJose = new Function(
  'return import("jose")',
) as () => Promise<JoseModule>;

const CACHE_KEY = Symbol.for('allva.jose-dynamic-import');

type ProcessWithJoseCache = NodeJS.Process & {
  [CACHE_KEY]?: Promise<JoseModule>;
};

/**
 * Memoizes the import on `process`, not on a module- or instance-level field.
 *
 * `AuthMiddleware`'s callers and `GoogleIdTokenVerifier` both import `jose`,
 * and under Jest's `--experimental-vm-modules` (required for this dynamic
 * import to resolve at all inside the test VM) each test **file** runs in its
 * own torn-down-after-use environment. A promise created in one file's
 * environment and awaited after that file's teardown rejects with `Test
 * environment has been torn down` — which `AuthMiddleware` then swallows as an
 * ordinary verification failure, turning a perfectly valid token into a `401`.
 * `process` is the one object Jest hands to every test file's environment as
 * the same, real reference, so caching the import there makes the dynamic
 * `import()` run at most once per process — in whichever file happens to
 * touch it first — instead of once per test file.
 */
export function loadJose(): Promise<JoseModule> {
  const proc = process as ProcessWithJoseCache;

  proc[CACHE_KEY] ??= importJose();

  return proc[CACHE_KEY];
}
