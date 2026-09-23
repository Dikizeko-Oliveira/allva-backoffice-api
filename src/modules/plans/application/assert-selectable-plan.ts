import { NotFoundException } from '@nestjs/common';
import { PlansRepositoryInterface } from 'src/modules/plans/domain/ports';
import { assertSelfServePlan } from './assert-self-serve-plan';

/**
 * O plano escolhido na vitrine pode abrir uma conta nova?
 *
 * Uma função para as portas que criam conta — senha, Google e Facebook —
 * porque o plano decide se a organização nasce no teste gratuito ou esperando o
 * primeiro pagamento, e uma porta que não perguntasse dava o teste a quem
 * clicou em Profissional. Foi exatamente o que acontecia com Google e Facebook.
 *
 * **Plano negociado recusa** (`PLAN_REQUIRES_SALES_CONTACT`): o Enterprise nasce
 * de um acordo comercial, e um cadastro que o escolhesse criaria conta e
 * organização fora desse caminho. O card da vitrine já leva a `/sales`, mas
 * `?next=<id do Enterprise>` sobrevive em link salvo e URL montada à mão.
 *
 * **Plano que não existe mais recusa** (`PLAN_NOT_FOUND`): seguir em frente
 * deixava o provisionamento sem achar o id e cair no teste gratuito — quem
 * clicou em Profissional numa aba com o catálogo antigo saía com 14 dias de
 * produto aberto. Recusar antes de criar a conta devolve a pessoa à escolha.
 *
 * Sem plano escolhido não há o que conferir: o cadastro segue e cai no teste.
 */
export async function assertSelectablePlan(
  plansRepository: PlansRepositoryInterface,
  planId?: string | null,
): Promise<void> {
  if (!planId) return;

  const plan = await plansRepository.findById(planId);

  if (!plan) {
    throw new NotFoundException({
      code: 'PLAN_NOT_FOUND',
      message: 'Selected plan is no longer available',
    });
  }

  assertSelfServePlan(plan.type);
}
