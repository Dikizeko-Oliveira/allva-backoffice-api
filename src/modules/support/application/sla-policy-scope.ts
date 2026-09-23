import { ConflictException } from '@nestjs/common';
import type { SlaPolicy } from '../domain/entities';
import type { SlaPoliciesRepositoryInterface } from '../domain/ports';

/**
 * Recusa a segunda política ativa no mesmo escopo (prioridade + categoria).
 *
 * O índice parcial do banco também recusa, mas com um erro de unicidade que
 * chegaria à tela como `500`. Aqui ele vira `409` com o id da política que já
 * ocupa o escopo — que é o que o operador precisa para resolver.
 */
export async function assertScopeIsFree(
  repository: SlaPoliciesRepositoryInterface,
  policy: SlaPolicy,
): Promise<void> {
  if (!policy.active) return;

  const current = await repository.findActiveByScope(
    policy.priority,
    policy.category,
  );

  if (!current || current.id === policy.id) return;

  throw new ConflictException({
    code: 'SLA_POLICY_SCOPE_TAKEN',
    message:
      'There is already an active SLA policy for this priority and category',
    details: { policyId: current.id },
  });
}
