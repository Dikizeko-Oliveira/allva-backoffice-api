import type {
  ActionTargetView,
  ConnectedActionTarget,
} from 'src/modules/platform-actions/domain/ports/action-targets.repository';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';

/**
 * As recusas do caminho de escrita que **não** vêm da cadeia de guardas.
 *
 * As de P5 nascem em `evaluateWriteGuards`, no domínio, porque são decisões
 * sobre o mundo — kill switch, consentimento, disponibilidade, teto. Estas três
 * são sobre o **pedido**: a instalação está em dry-run obrigatório, a chave foi
 * reusada, o alvo não existe nesta hierarquia. Ficam na aplicação, junto de quem
 * as levanta, e fora do use case para que ele continue lendo como a sequência de
 * decisões que é.
 */

/**
 * RP5 — a tranca das duas semanas de observação em produção.
 *
 * Precede qualquer outra verificação: recusar depois faria a recusa depender de
 * o anúncio estar saudável, e a tranca deixaria de ser uma tranca.
 */
export function dryRunOnlyRefusal(): DomainError {
  return new DomainError({
    code: 'PLATFORM_WRITE_DRY_RUN_ONLY',
    category: 'PRECONDITION_FAILED',
    message:
      'Esta instalação está em dry-run obrigatório: nenhuma escrita real é executada.',
    remediation:
      'Use dryRun=true. A escrita real é liberada ao fim do período de observação.',
  });
}

/**
 * A8 — mesma chave, pedido diferente.
 *
 * Devolver "o original" aqui devolveria o resultado de **outra** ação, e o
 * cliente a registraria como se fosse a que pediu.
 */
export function idempotencyReuseRefusal(): DomainError {
  return new DomainError({
    code: 'IDEMPOTENCY_KEY_REUSED',
    category: 'IDEMPOTENCY_KEY_REUSED',
    message:
      'Esta Idempotency-Key já foi usada com outro pedido nesta organização.',
    remediation: 'Use uma chave nova para um pedido diferente.',
  });
}

/**
 * O anúncio não tem a entidade em que a ação incidiria — o caso do Google
 * Search, cuja hierarquia não tem o nível intermediário.
 *
 * Não é indisponibilidade da plataforma, e o texto diz isso: a diferença entre
 * "não fazemos isso" e "não há o que fazer aqui" é o que impede o usuário de
 * abrir chamado sobre uma limitação que não existe.
 */
export function targetAbsentRefusal(adSetLabel: string): DomainError {
  return new DomainError({
    code: 'ACTION_TARGET_ABSENT',
    category: 'UNSUPPORTED_BY_PLATFORM',
    message: `Este anúncio não tem ${adSetLabel} sobre o qual agir.`,
  });
}

/**
 * P10 — a conta de anúncios está sem credencial.
 *
 * Distinta de `NotFoundException`, e a distinção é o ponto: o anúncio existe,
 * está na organização e continua gastando. Enquanto as duas condições saíam como
 * `404 Anúncio não encontrado`, o usuário procurava um anúncio sumido em vez de
 * reconectar a integração — e a remediação, que é a informação útil, não existia.
 */
export function accountDisconnectedRefusal(): DomainError {
  return new DomainError({
    code: 'AD_ACCOUNT_DISCONNECTED',
    category: 'PRECONDITION_FAILED',
    message:
      'A conta de anúncios deste anúncio está sem credencial: nada pode ser enviado à plataforma.',
    remediation:
      'Reconecte a integração desta conta de anúncios para voltar a executar ações.',
  });
}

/**
 * A guarda que precede toda escrita, nos dois caminhos que a fazem.
 *
 * Assertiva em vez de `if` repetido: além de recusar, ela **estreita o tipo**
 * para `ConnectedActionTarget`, que é o que a cadeia de guardas exige. Duplicar
 * a checagem deixaria os dois caminhos livres para divergir — e o que diverge
 * numa recusa de escrita é dinheiro saindo por uma porta que a outra fechou.
 */
export function assertConnected(
  target: ActionTargetView,
): asserts target is ConnectedActionTarget {
  if (target.integrationId === null) throw accountDisconnectedRefusal();
}

/** R14 — a recusa de conteúdo autoral, já tipada pelo domínio. */
export function authoredContentRefusal(failure: {
  code: string;
  message: string;
  remediation: string;
}): DomainError {
  return new DomainError({
    code: failure.code,
    category: 'VALIDATION',
    message: failure.message,
    remediation: failure.remediation,
  });
}

/**
 * §9.6 — só escrita que **aconteceu** se reverte.
 *
 * Uma execução recusada não mudou nada, e "reverter" nela escreveria um estado
 * que a plataforma nunca teve.
 */
export function notRevertibleRefusal(details: {
  status: string;
  dryRun: boolean;
}): DomainError {
  return new DomainError({
    code: 'EXECUTION_NOT_REVERTIBLE',
    category: 'PRECONDITION_FAILED',
    message:
      'Só uma execução concluída com sucesso e fora de dry-run pode ser revertida.',
    details,
  });
}

/** O que arquiva ou recria não volta por escrita (§13.1). */
export function noInverseActionRefusal(actionType: string): DomainError {
  return new DomainError({
    code: 'ACTION_NOT_REVERTIBLE',
    category: 'UNSUPPORTED_BY_PLATFORM',
    message: `${actionType} não tem ação inversa declarada.`,
    remediation:
      'Ações que arquivam ou recriam entidades não voltam por escrita.',
  });
}

/** Reverter sem estado anterior confiável seria inventar um estado. */
export function revertStateUnavailableRefusal(reason: string): DomainError {
  return new DomainError({
    code: 'REVERT_STATE_UNAVAILABLE',
    category: 'PRECONDITION_FAILED',
    message: reason,
    remediation:
      'Aplique a ação inversa manualmente: não há estado anterior confiável para restaurar.',
  });
}

/** I2 — o banco arbitrou a corrida contra este pedido. */
export function writeInFlightRefusal(
  inFlightExecutionId: string | null,
): DomainError {
  return new DomainError({
    code: 'WRITE_IN_FLIGHT',
    category: 'WRITE_IN_FLIGHT',
    message: 'Já existe uma escrita em andamento sobre este alvo.',
    details: { inFlightExecutionId },
    remediation:
      'Aguarde a execução em voo terminar — ela vence em 15 minutos.',
  });
}

/**
 * O plano não inclui a capacidade pedida.
 *
 * Delega à recusa canônica de `plans`: quatro superfícies levantam esta mesma
 * condição, e quatro frases ligeiramente diferentes para ela dariam à tela
 * quatro casos onde há um. Existe aqui, e não só lá, porque o lote é recusado
 * **como pedido** — antes de haver ação a julgar — e a cadeia de guardas só
 * opina sobre uma ação de cada vez.
 */
export { planLimitRefusal as planFeatureRefusal } from 'src/modules/plans/application/plan-limit-refusal';
