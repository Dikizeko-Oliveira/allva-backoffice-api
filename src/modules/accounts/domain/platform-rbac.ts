/**
 * RBAC de **plataforma** — quem opera a Allva, não quem a usa.
 *
 * Distinto de `organizations/domain/rbac`, que responde "o que este membro
 * pode dentro da organização dele". Aqui a pergunta é "o que este operador
 * pode sobre todas as organizações". Os dois conjuntos de permissão não se
 * encontram e não devem ser unificados: um tipo só, com as duas listas,
 * deixaria o compilador aceitar `billing:manage` sem dizer de qual billing se
 * trata.
 *
 * ## Espelho do backoffice
 *
 * A matriz é a mesma de `allva-backoffice-web/src/modules/platform/types/rbac.ts`,
 * papel a papel e permissão a permissão. O backoffice decide o que **mostrar**;
 * este arquivo decide o que **responder**. Divergir as duas é como uma tela
 * aparece com botões que a API recusa — ou, pior, uma API que aceita o que a
 * tela esconde. `platform-rbac.spec.ts` fixa a matriz para que uma mudança de
 * um lado seja uma decisão, não um desvio.
 *
 * ## Capacidade, nunca hierarquia
 *
 * Suporte, financeiro, operações e comercial são faixas paralelas e
 * disjuntas, não degraus. Só `ALLVA_ADMIN` está acima de todos — e mesmo ele
 * recebe as permissões por enumeração, não por ser "o maior". Autorizar por
 * `>=` daria ao financeiro o poder de mexer em atendimento numa escada que
 * nunca foi sobre isso; `organizations/domain/rbac/permissions.ts` documenta o
 * mesmo risco do lado do cliente, e `test/architecture/authorization-model`
 * o cobra.
 *
 * Sem import de framework: é domínio, e o gate de camadas recusa Nest aqui.
 * A recusa HTTP mora em `accounts/application/platform-authorization.ts`.
 */

export const PLATFORM_ROLES = [
  'ALLVA_ADMIN',
  'ALLVA_OPERATOR',
  'ALLVA_SUPPORT',
  'ALLVA_FINANCE',
  'ALLVA_SALES',
] as const;

export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const PLATFORM_PERMISSIONS = [
  'dashboard:read',
  'orgs:read',
  'orgs:manage',
  'orgs:quota_manage',
  'users:read',
  'users:manage',
  'users:manage_platform_role',
  'leads:read',
  'leads:manage',
  'support:read',
  'support:manage',
  'contacts:read',
  'contacts:manage',
  'subscriptions:read',
  'subscriptions:manage',
  'billing:read',
  'billing:manage',
  'integrations:read',
  'integrations:manage',
  'operations:read',
  'operations:execute',
  'audit:read',
  'settings:read',
  'settings:manage',
] as const;

export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];

/**
 * Papel → permissões.
 *
 * Fronteiras decididas no backoffice, e que vale conhecer antes de mexer:
 *
 * - `orgs:quota_manage` é do financeiro, não de operações: limite contratado
 *   é cláusula comercial, e quem altera limite altera o que foi vendido.
 * - `orgs:manage` é só da administração. É o que ativa, suspende, reativa e
 *   cancela contrato — os quatro atos que criam ou fecham o acesso de uma
 *   organização inteira.
 * - `audit:read` é de administração e operações. Suporte e comercial veem o
 *   histórico da conta que atendem pelas telas da área, não a trilha inteira.
 * - `users:manage_platform_role` é só da administração: quem concede papel
 *   concede poder, e é a única permissão que se auto-multiplica.
 * - `integrations:read` é do suporte (diagnosticar "não sincroniza"), mas
 *   `integrations:manage` não: reconectar credencial de cliente é operação.
 */
export const PLATFORM_ROLE_PERMISSIONS: Readonly<
  Record<PlatformRole, readonly PlatformPermission[]>
> = {
  ALLVA_ADMIN: [...PLATFORM_PERMISSIONS],

  ALLVA_OPERATOR: [
    'dashboard:read',
    'orgs:read',
    'integrations:read',
    'integrations:manage',
    'operations:read',
    'operations:execute',
    'audit:read',
  ],

  ALLVA_SUPPORT: [
    'dashboard:read',
    'orgs:read',
    'users:read',
    'support:read',
    'support:manage',
    'contacts:read',
    'contacts:manage',
    'subscriptions:read',
    'integrations:read',
  ],

  ALLVA_FINANCE: [
    'dashboard:read',
    'orgs:read',
    'orgs:quota_manage',
    'users:read',
    'subscriptions:read',
    'subscriptions:manage',
    'billing:read',
    'billing:manage',
  ],

  ALLVA_SALES: ['dashboard:read', 'orgs:read', 'leads:read', 'leads:manage'],
};

/**
 * O papel da conta é de plataforma?
 *
 * Recebe `string` e não `PlatformRole` porque a entrada é `Account.role`,
 * que também pode ser `USER` — e é essa a pergunta.
 */
export function isPlatformRole(
  role: string | null | undefined,
): role is PlatformRole {
  return (PLATFORM_ROLES as readonly string[]).includes(role ?? '');
}

/**
 * **Fecha na dúvida.** Papel ausente, `USER` ou desconhecido não tem
 * permissão nenhuma. Um papel que entrar no enum do banco sem entrada nesta
 * matriz também cai aqui — e o teste de paridade com o schema existe para que
 * isso seja pego antes do deploy, e não descoberto como "o novo papel não
 * consegue nada".
 */
export function roleHasPlatformPermission(
  role: string | null | undefined,
  permission: PlatformPermission,
): boolean {
  if (!isPlatformRole(role)) return false;
  return PLATFORM_ROLE_PERMISSIONS[role].includes(permission);
}

/** Cópia, para quem recebe não conseguir mutar a matriz por referência. */
export function permissionsForRole(
  role: string | null | undefined,
): PlatformPermission[] {
  return isPlatformRole(role) ? [...PLATFORM_ROLE_PERMISSIONS[role]] : [];
}
