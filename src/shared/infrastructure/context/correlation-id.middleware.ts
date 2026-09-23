import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { RequestContextService } from './request-context.service';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

export type RequestWithCorrelation = Request & { correlationId?: string };

/**
 * Estabelece o `correlationId` da requisição (§5.6.2).
 *
 * *"Um interceptor gera o id por requisição, honrando `X-Correlation-Id` de
 * entrada quando houver."* Honrar o de entrada é o que faz a cadeia começar no
 * BFF e não na API: sem isso, "o que aconteceu por causa daquele clique" para
 * na fronteira do backend, que é justamente onde os efeitos começam.
 *
 * É middleware e não interceptor porque precisa ser o **primeiro** elo — antes
 * de auth, antes do contexto de organização — para que qualquer erro levantado
 * nesses passos já saia com o id no header.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  constructor(private readonly requestContext: RequestContextService) {}

  use(req: RequestWithCorrelation, res: Response, next: NextFunction): void {
    const incoming = req.headers[CORRELATION_ID_HEADER];
    const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
    // Um id de entrada absurdo viraria chave de busca inútil no log — e um
    // header longo o bastante é vetor de ruído. 200 caracteres cobre qualquer
    // formato legítimo (UUID, trace id do W3C, id do BFF).
    const correlationId =
      candidate && candidate.trim().length > 0 && candidate.length <= 200
        ? candidate.trim()
        : randomUUID();

    req.correlationId = correlationId;
    res.setHeader(CORRELATION_ID_HEADER, correlationId);

    this.requestContext.run({ correlationId }, () => next());
  }
}
