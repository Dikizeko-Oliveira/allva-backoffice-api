import { HttpStatus } from '@nestjs/common';
import { DomainErrorCategory } from 'src/shared/domain/error-category';

/**
 * As 13 categorias de §7.0.4 **moraram aqui até A2-S7**, e mudaram para
 * `shared/domain` quando a cadeia de guardas de P5 passou a decidir a categoria
 * dentro do domínio — que não pode importar infraestrutura (§16.6). Mesmo
 * caminho de `MoneyView`: definição no domínio, reexportada por quem serve
 * HTTP, para que continue existindo **uma** lista.
 */
export type { DomainErrorCategory };

/** O mapa normativo de §7.0.4. Nenhuma rota escolhe o próprio status. */
export const DOMAIN_ERROR_HTTP_STATUS: Readonly<
  Record<DomainErrorCategory, number>
> = {
  VALIDATION: HttpStatus.BAD_REQUEST,
  IDEMPOTENCY_KEY_REUSED: HttpStatus.CONFLICT,
  NOT_PERMITTED: HttpStatus.FORBIDDEN,
  PLAN_LIMITED: HttpStatus.FORBIDDEN,
  CONSENT_REQUIRED: HttpStatus.FORBIDDEN,
  KILL_SWITCH: HttpStatus.FORBIDDEN,
  PRECONDITION_FAILED: HttpStatus.CONFLICT,
  WRITE_IN_FLIGHT: HttpStatus.CONFLICT,
  CONFLICTING_RECOMMENDATION: HttpStatus.CONFLICT,
  UNSUPPORTED_BY_PLATFORM: HttpStatus.UNPROCESSABLE_ENTITY,
  PLATFORM_REJECTED: HttpStatus.UNPROCESSABLE_ENTITY,
  INSUFFICIENT_EVIDENCE: HttpStatus.UNPROCESSABLE_ENTITY,
  RATE_LIMITED: HttpStatus.TOO_MANY_REQUESTS,
  INTEGRATION_UNREACHABLE: HttpStatus.SERVICE_UNAVAILABLE,
  CURRENCY_RECOMPUTING: HttpStatus.SERVICE_UNAVAILABLE,
};

/**
 * Categorias em que **tentar de novo mais tarde** é a conduta certa: o pedido
 * está correto, o sistema é que não pode atendê-lo agora.
 *
 * As demais são `retryable: false` por padrão — repetir um 403 de RBAC ou um
 * 422 de capability só gasta chamada. `retryable` é sobrescrevível caso a caso
 * (uma recusa de plataforma por instabilidade momentânea, por exemplo), mas o
 * default nunca convida o cliente a insistir num "não" definitivo.
 */
const RETRYABLE_CATEGORIES: ReadonlySet<DomainErrorCategory> = new Set([
  'RATE_LIMITED',
  'INTEGRATION_UNREACHABLE',
  'CURRENCY_RECOMPUTING',
  'WRITE_IN_FLIGHT',
]);

export type DomainErrorProps = {
  /** Código específico e estável — `RECOMMENDATION_PREMISE_STALE`, não `ERR_409`. */
  code: string;
  category: DomainErrorCategory;
  message: string;
  /** Estrutura livre por código; é onde o erro da plataforma aterrissa. */
  details?: Record<string, unknown>;
  /** O que o cliente (ou o usuário) faz agora. Texto de tela, não de log. */
  remediation?: string;
  retryable?: boolean;
};

/**
 * O erro tipado de §7.0.4. Único caminho de erro da superfície ads-first.
 *
 * `code` e `category` respondem coisas diferentes de propósito: a categoria
 * decide o HTTP e o comportamento genérico do cliente; o código identifica o
 * caso específico e é o que a UI usa para escolher a mensagem. Achatar os dois
 * num campo só obrigaria o front a fazer `switch` em string para descobrir se
 * pode tentar de novo.
 */
export class DomainError extends Error {
  readonly code: string;
  readonly category: DomainErrorCategory;
  readonly details?: Record<string, unknown>;
  readonly remediation?: string;
  readonly retryable: boolean;

  constructor(props: DomainErrorProps) {
    super(props.message);
    this.name = 'DomainError';
    this.code = props.code;
    this.category = props.category;
    this.details = props.details;
    this.remediation = props.remediation;
    this.retryable =
      props.retryable ?? RETRYABLE_CATEGORIES.has(props.category);
  }

  get httpStatus(): number {
    return DOMAIN_ERROR_HTTP_STATUS[this.category];
  }
}

export type DomainErrorBody = {
  error: {
    code: string;
    category: DomainErrorCategory;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
    remediation?: string;
  };
};

/**
 * Serializa o erro no formato de §7.0.4.
 *
 * Função pura, e não método do filtro, porque dois caminhos precisam produzir
 * exatamente o mesmo corpo: o `DomainErrorFilter` e o `GlobalExceptionFilter`,
 * que trata `DomainError` diretamente para que a resposta não dependa da ordem
 * em que os filtros globais foram registrados.
 */
export function renderDomainError(error: DomainError): {
  status: number;
  body: DomainErrorBody;
} {
  return {
    status: error.httpStatus,
    body: {
      error: {
        code: error.code,
        category: error.category,
        message: error.message,
        retryable: error.retryable,
        ...(error.details ? { details: error.details } : {}),
        ...(error.remediation ? { remediation: error.remediation } : {}),
      },
    },
  };
}
