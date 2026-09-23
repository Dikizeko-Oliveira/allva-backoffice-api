import { Injectable } from '@nestjs/common';
import { OrganizationLimitService } from 'src/modules/organizations/application/services/organization-limit.service';
import { planLabel } from 'src/modules/plans/domain/plan-entitlements';
import { OrganizationCreationAllowanceOutputDto } from '../dtos';

/**
 * "Posso criar outra organização?" — a pergunta que a tela não tinha como fazer.
 *
 * Delega inteiramente a `OrganizationLimitService`, que é o que dá valor à
 * resposta: é a mesma chamada que `CreateOrganizationUseCase` faz antes de
 * gravar, então esta rota não *prevê* a recusa, ela a **executa** sem o efeito
 * colateral. Reimplementar o cálculo aqui — ou no front — traria de volta duas
 * respostas para a mesma pergunta.
 */
@Injectable()
export class GetOrganizationCreationAllowanceUseCase {
  constructor(private readonly limits: OrganizationLimitService) {}

  async execute(
    accountId: string,
  ): Promise<OrganizationCreationAllowanceOutputDto> {
    const allowance = await this.limits.resolveForAccount(accountId);

    return {
      allowed: allowance.state.allowed,
      used: allowance.used,
      limit: allowance.limit,
      // `planLabel()` devolve "atual" para plano irresolúvel, que é frase de
      // recusa e não nome de plano — sem referência a resposta honesta é nula.
      planLabel: allowance.referencePlanType
        ? planLabel(allowance.referencePlanType)
        : null,
      upgradeTo: allowance.state.allowed ? null : allowance.state.upgradeTo,
    };
  }
}
