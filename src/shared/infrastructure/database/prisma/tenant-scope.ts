import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * O tenant que o Postgres enxerga — **a ponte entre o contexto da requisição e
 * a política de RLS** (R9).
 *
 * A política compara `organization_id` com
 * `current_setting('app.organization_id')`. Alguém tem de setá-la, e o "alguém"
 * não pode ser cada repositório: são ~20 lugares abrindo transação, e a garantia
 * de isolamento não pode depender de nenhum deles lembrar.
 *
 * ## Por que um store próprio, e não `RequestContextService`
 *
 * `RequestContextService` é injetável e vive no grafo do Nest;
 * `PrismaService` é construído no `useClass` do módulo global de banco e
 * precisa do tenant **antes** de qualquer injeção resolver. Um módulo com
 * estado próprio quebra o ovo-e-galinha sem inverter o grafo.
 *
 * Os dois são preenchidos pelo mesmo middleware, e o teste de arquitetura cobra
 * que continuem em sincronia.
 *
 * ## O que acontece fora de requisição
 *
 * Workers e jobs rodam sem tenant no store. Sob `app_rw`, isso significa **zero
 * linhas** — e é correto: um job de organização declara a sua com
 * `runInTenant`, e um job global roda sob `app_maintenance`, que tem BYPASSRLS.
 * O estado vazio nunca é erro; é ausência de autorização, e ausência de
 * autorização deve devolver nada.
 */

type TenantStore = { organizationId: string | null };

const storage = new AsyncLocalStorage<TenantStore>();

/** Executa `callback` com o tenant ativo — HTTP ou job de organização. */
export function runInTenant<T>(
  organizationId: string | null,
  callback: () => T,
): T {
  return storage.run({ organizationId }, callback);
}

/** O tenant ativo, ou `null` fora de requisição e de job com organização. */
export function currentTenant(): string | null {
  return storage.getStore()?.organizationId ?? null;
}

/**
 * Escapa o valor para interpolação em `SET LOCAL`.
 *
 * `SET LOCAL` **não aceita parâmetro ligado** — é comando de sessão, não
 * consulta. O valor vem de `OwnerScopeResolverService`, que o lê do vínculo do
 * usuário autenticado e nunca do corpo da requisição, então não é entrada de
 * usuário. A validação existe mesmo assim: a garantia de que continua não sendo
 * é do código de hoje, e esta linha é a que sobrevive à próxima refatoração.
 */
export function assertSafeTenantId(organizationId: string): string {
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(organizationId)) {
    throw new Error(
      `tenant.invalid_id="${organizationId}" — só uuid/cuid são aceitos em SET LOCAL`,
    );
  }

  return organizationId;
}
