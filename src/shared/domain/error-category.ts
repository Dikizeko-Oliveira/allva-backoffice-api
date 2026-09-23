/**
 * As 13 categorias de erro de §7.0.4, **no domínio**.
 *
 * Vivem aqui e não em `infrastructure/http` pela mesma razão que `MoneyView`:
 * regras de domínio decidem a categoria — a cadeia de guardas de P5 responde
 * "isto é kill switch ou é consentimento faltando?" — e domínio não importa
 * infraestrutura (§16.6). O `DomainError` da camada HTTP reexporta este tipo:
 * uma definição só, na camada que todas as outras podem importar.
 *
 * *"Num produto em que a ação move dinheiro, o erro é a informação."* "Não dá
 * para fazer isso" e "não dá para fazer isso **agora**" pedem telas diferentes,
 * e um 409 genérico não distingue as duas.
 */
export type DomainErrorCategory =
  | 'VALIDATION'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'NOT_PERMITTED'
  /**
   * O plano contratado não inclui a capacidade — 403 como `NOT_PERMITTED`, e
   * categoria própria pela razão que abre este arquivo: as duas pedem telas
   * diferentes. "Você não tem permissão" manda o usuário falar com o admin da
   * organização; "seu plano não inclui" manda para a página de planos, e trocar
   * uma pela outra manda cada um para o lugar onde ninguém pode ajudá-lo.
   */
  | 'PLAN_LIMITED'
  | 'CONSENT_REQUIRED'
  | 'KILL_SWITCH'
  | 'PRECONDITION_FAILED'
  | 'WRITE_IN_FLIGHT'
  | 'CONFLICTING_RECOMMENDATION'
  | 'UNSUPPORTED_BY_PLATFORM'
  | 'PLATFORM_REJECTED'
  | 'INSUFFICIENT_EVIDENCE'
  | 'RATE_LIMITED'
  | 'INTEGRATION_UNREACHABLE'
  | 'CURRENCY_RECOMPUTING';
