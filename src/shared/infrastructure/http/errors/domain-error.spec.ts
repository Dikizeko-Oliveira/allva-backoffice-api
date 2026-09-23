import { ArgumentsHost } from '@nestjs/common';
import {
  DOMAIN_ERROR_HTTP_STATUS,
  DomainError,
  DomainErrorCategory,
  renderDomainError,
} from './domain-error';
import { DomainErrorFilter } from './domain-error.filter';

/** As 13 categorias de §7.0.4 com o HTTP que cada uma deve produzir. */
const EXPECTED_STATUS: Record<DomainErrorCategory, number> = {
  VALIDATION: 400,
  IDEMPOTENCY_KEY_REUSED: 409,
  NOT_PERMITTED: 403,
  PLAN_LIMITED: 403,
  CONSENT_REQUIRED: 403,
  KILL_SWITCH: 403,
  PRECONDITION_FAILED: 409,
  WRITE_IN_FLIGHT: 409,
  CONFLICTING_RECOMMENDATION: 409,
  UNSUPPORTED_BY_PLATFORM: 422,
  PLATFORM_REJECTED: 422,
  INSUFFICIENT_EVIDENCE: 422,
  RATE_LIMITED: 429,
  INTEGRATION_UNREACHABLE: 503,
  CURRENCY_RECOMPUTING: 503,
};

describe('DomainError', () => {
  it('declara as 13 categorias de §7.0.4 com o HTTP correspondente', () => {
    expect(DOMAIN_ERROR_HTTP_STATUS).toEqual(EXPECTED_STATUS);
  });

  it.each(Object.entries(EXPECTED_STATUS))(
    'mapeia %s para HTTP %i',
    (category, status) => {
      const error = new DomainError({
        code: 'X',
        category: category as DomainErrorCategory,
        message: 'm',
      });

      expect(error.httpStatus).toBe(status);
    },
  );

  it('marca como retryable só o que muda sozinho com o tempo', () => {
    const retryable = (category: DomainErrorCategory) =>
      new DomainError({ code: 'X', category, message: 'm' }).retryable;

    expect(retryable('RATE_LIMITED')).toBe(true);
    expect(retryable('INTEGRATION_UNREACHABLE')).toBe(true);
    expect(retryable('CURRENCY_RECOMPUTING')).toBe(true);
    expect(retryable('WRITE_IN_FLIGHT')).toBe(true);

    expect(retryable('NOT_PERMITTED')).toBe(false);
    expect(retryable('UNSUPPORTED_BY_PLATFORM')).toBe(false);
    expect(retryable('IDEMPOTENCY_KEY_REUSED')).toBe(false);
  });

  it('permite sobrescrever retryable no caso concreto', () => {
    const error = new DomainError({
      code: 'PLATFORM_TEMPORARY',
      category: 'PLATFORM_REJECTED',
      message: 'instabilidade momentânea',
      retryable: true,
    });

    expect(error.retryable).toBe(true);
  });

  it('serializa exatamente o envelope de erro de §7.0.4', () => {
    const error = new DomainError({
      code: 'RECOMMENDATION_PREMISE_STALE',
      category: 'PRECONDITION_FAILED',
      message:
        'As conversões deste anúncio foram re-declaradas pela plataforma.',
      details: {
        reason: 'WASTE_RESOLVED_BY_RESTATEMENT',
        wasteItemIds: ['uuid'],
      },
      remediation:
        'A recomendação foi expirada. Uma nova será gerada no próximo ciclo.',
    });

    expect(renderDomainError(error)).toEqual({
      status: 409,
      body: {
        error: {
          code: 'RECOMMENDATION_PREMISE_STALE',
          category: 'PRECONDITION_FAILED',
          message:
            'As conversões deste anúncio foram re-declaradas pela plataforma.',
          retryable: false,
          details: {
            reason: 'WASTE_RESOLVED_BY_RESTATEMENT',
            wasteItemIds: ['uuid'],
          },
          remediation:
            'A recomendação foi expirada. Uma nova será gerada no próximo ciclo.',
        },
      },
    });
  });

  it('omite details e remediation quando não há o que dizer', () => {
    const { body } = renderDomainError(
      new DomainError({ code: 'X', category: 'VALIDATION', message: 'm' }),
    );

    expect(body.error).not.toHaveProperty('details');
    expect(body.error).not.toHaveProperty('remediation');
  });
});

describe('DomainErrorFilter', () => {
  it('responde com o status da categoria e o corpo tipado', () => {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const host = {
      switchToHttp: () => ({ getResponse: () => ({ status }) }),
    } as unknown as ArgumentsHost;

    new DomainErrorFilter().catch(
      new DomainError({
        code: 'WRITE_IN_FLIGHT',
        category: 'WRITE_IN_FLIGHT',
        message: 'já há escrita em voo neste alvo',
        details: { inFlightExecutionId: 'exec-1' },
      }),
      host,
    );

    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith({
      error: {
        code: 'WRITE_IN_FLIGHT',
        category: 'WRITE_IN_FLIGHT',
        message: 'já há escrita em voo neste alvo',
        retryable: true,
        details: { inFlightExecutionId: 'exec-1' },
      },
    });
  });
});
