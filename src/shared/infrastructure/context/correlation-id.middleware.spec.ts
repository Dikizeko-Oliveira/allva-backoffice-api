import { Response } from 'express';
import {
  CORRELATION_ID_HEADER,
  CorrelationIdMiddleware,
  RequestWithCorrelation,
} from './correlation-id.middleware';
import { RequestContextService } from './request-context.service';

function requestWith(headers: Record<string, string | string[]> = {}) {
  return { headers } as unknown as RequestWithCorrelation;
}

function responseSpy() {
  const setHeader = jest.fn();
  return { response: { setHeader } as unknown as Response, setHeader };
}

describe('CorrelationIdMiddleware', () => {
  let context: RequestContextService;
  let middleware: CorrelationIdMiddleware;

  beforeEach(() => {
    context = new RequestContextService();
    middleware = new CorrelationIdMiddleware(context);
  });

  it('honra o X-Correlation-Id de entrada', () => {
    const req = requestWith({ [CORRELATION_ID_HEADER]: 'bff-123' });
    const { response, setHeader } = responseSpy();
    let seen: string | undefined;

    middleware.use(req, response, () => {
      seen = context.getCorrelationId();
    });

    expect(req.correlationId).toBe('bff-123');
    expect(seen).toBe('bff-123');
    expect(setHeader).toHaveBeenCalledWith(CORRELATION_ID_HEADER, 'bff-123');
  });

  it('gera um id quando a requisição não traz nenhum', () => {
    const req = requestWith();
    const { response } = responseSpy();

    middleware.use(req, response, () => undefined);

    expect(req.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('descarta valor de entrada vazio ou absurdamente longo', () => {
    const { response } = responseSpy();

    const blank = requestWith({ [CORRELATION_ID_HEADER]: '   ' });
    middleware.use(blank, response, () => undefined);
    expect(blank.correlationId).toMatch(/^[0-9a-f-]{36}$/);

    const huge = requestWith({ [CORRELATION_ID_HEADER]: 'x'.repeat(201) });
    middleware.use(huge, response, () => undefined);
    expect(huge.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('usa o primeiro valor quando o header chega repetido', () => {
    const req = requestWith({ [CORRELATION_ID_HEADER]: ['a-1', 'a-2'] });
    const { response } = responseSpy();

    middleware.use(req, response, () => undefined);

    expect(req.correlationId).toBe('a-1');
  });
});

describe('RequestContextService.runMerging', () => {
  it('preserva o que já estava no contexto', () => {
    const context = new RequestContextService();
    let seen: { correlationId?: string; organizationId?: string } = {};

    context.run({ correlationId: 'corr-1' }, () => {
      context.runMerging({ organizationId: 'org-1' }, () => {
        seen = {
          correlationId: context.getCorrelationId(),
          organizationId: context.getOrganizationId(),
        };
      });
    });

    // Um `run` puro aqui teria apagado a correlação — e a cadeia morreria no
    // primeiro salto, em silêncio.
    expect(seen).toEqual({ correlationId: 'corr-1', organizationId: 'org-1' });
  });
});
