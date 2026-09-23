import type { PlanEntitlementState } from 'src/modules/plans/domain/plan-entitlements';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';

/**
 * A recusa por plano, **uma só para o produto inteiro**.
 *
 * Quatro superfícies a levantam hoje — escrita em plataforma, lote, integrações
 * e relatórios — e cada uma escrevendo a própria produziria quatro frases
 * ligeiramente diferentes para a mesma condição. A tela trataria as quatro com
 * um `if` por superfície, e a quinta chegaria sem tela.
 *
 * `PLAN_LIMITED` é 403 como `NOT_PERMITTED`, e é categoria própria porque as
 * duas pedem telas diferentes: uma manda falar com o administrador da
 * organização, a outra manda para a página de planos.
 */
export function planLimitRefusal(
  state: Extract<PlanEntitlementState, { allowed: false }>,
): DomainError {
  return new DomainError({
    code: 'PLAN_FEATURE_NOT_INCLUDED',
    category: 'PLAN_LIMITED',
    message: messageFor(state),
    remediation: state.upgradeTo
      ? `Contrate o plano ${state.upgradeTo} para liberar.`
      : 'Fale com o time comercial para liberar.',
    details: {
      feature: state.featureLabel,
      planLabel: state.planLabel,
      upgradeTo: state.upgradeTo,
      ...(state.quota ? { quota: state.quota } : {}),
    },
  });
}

/**
 * "Não inclui" e "acabou" são recusas diferentes, e a frase precisa dizer qual.
 *
 * Quem pediu TikTok num plano sem TikTok não tem o que fazer além de mudar de
 * plano. Quem bateu no teto de contas pode desconectar uma — e a mensagem que
 * omite o número esconde justamente essa saída.
 */
function messageFor(
  state: Extract<PlanEntitlementState, { allowed: false }>,
): string {
  const feature = state.featureLabel.toLowerCase();

  if (state.quota) {
    // Sem "em": o rótulo do catálogo já é um substantivo contável ("contas de
    // anúncios conectadas", "assentos"), e a preposição fazia a frase ler como
    // se o número medisse outra coisa.
    return `O plano ${state.planLabel} inclui ${state.quota.limit} ${feature}, e este limite já foi atingido.`;
  }

  return `O plano ${state.planLabel} não inclui ${feature}.`;
}
