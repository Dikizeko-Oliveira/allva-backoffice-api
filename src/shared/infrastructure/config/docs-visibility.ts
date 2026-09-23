/**
 * Whether to mount `/docs`, `/docs-json` and `/scalar`.
 *
 * Those routes are served without authentication, so in production they publish
 * the entire API surface — every route, request schema and error code — to
 * anyone who asks. They used to be mounted unconditionally.
 *
 * Default follows the environment; `DOCS_ENABLED` overrides it in either
 * direction, so a staging box can keep them and a self-hosted deploy can turn
 * them on deliberately. Reads `process.env` rather than `EnvService` because the
 * decision happens in `bootstrap()`, alongside the other pre-DI setup.
 */
export function areDocsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const explicit = env.DOCS_ENABLED?.trim();

  if (explicit === 'true') return true;
  if (explicit === 'false') return false;

  return (env.NODE_ENV ?? 'development') !== 'production';
}
