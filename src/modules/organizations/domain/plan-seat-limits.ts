export type PlanType = 'FREE' | 'STARTER' | 'PRO' | 'ENTERPRISE';

/**
 * Maximum seats (ACTIVE members + pending invitations, the owner included) an
 * organization may hold per plan. `null` means unlimited.
 *
 * Kept as config-in-code for now — it can move to a `Plan.maxMembers` column
 * later without changing any caller, since enforcement goes through
 * {@link resolveSeatLimit}.
 */
export const PLAN_SEAT_LIMITS: Record<PlanType, number | null> = {
  // FREE é o teste gratuito, e o teste entrega o PRO inteiro — por isso o mesmo
  // teto. Um time que avalia a ferramenta precisa avaliá-la como time; deixar o
  // teste em 1 assento faria a landing prometer 10 e a guarda recusar o segundo
  // convite. Ver `TRIAL_MIRRORS` em plans/domain/plan-catalog.ts.
  FREE: 10,
  STARTER: 3,
  PRO: 10,
  /**
   * Piso do contrato, não teto — o número real mora em
   * `organization_quotas.max_seats`.
   *
   * Era `null` (ilimitado), e ilimitado deixou de existir no Enterprise: ele
   * fazia a entrega escalar sem a receita escalar junto. `resolveSeatLimit`
   * continua devolvendo `null` para plano irresolúvel, que é outra coisa —
   * "não sei" abre, "negociado" tem número.
   */
  ENTERPRISE: 25,
};

/**
 * Resolves the seat limit for a plan. An unknown/absent plan returns `null`
 * (fail open) so a missing subscription never blocks a legitimate invite —
 * provisioned organizations always carry a plan, so this only guards edge cases.
 */
export function resolveSeatLimit(
  planType: PlanType | null | undefined,
): number | null {
  if (!planType) return null;
  return PLAN_SEAT_LIMITS[planType] ?? null;
}
