import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { NextFunction, Response } from 'express';
import { RequestWithCorrelation } from './correlation-id.middleware';

/**
 * Uma linha por requisição, com o `correlationId` (GAP-058, 2026-11-05) — a
 * mesma do `allva-api`, para o id ligar as duas pontas no log da VPS.
 *
 * O id já atravessava os quatro serviços e voltava no header, mas não aparecia
 * em nenhuma linha de log: um beta user que reportasse "deu erro" com o print
 * do id não levava a lugar nenhum. Esta é a linha que liga o relato ao log.
 *
 * O que entra é o mínimo para isso: método, caminho, status, duração e id.
 * **Caminho sem query**, pela mesma razão do filtro global (SEC-15): a query
 * de algumas rotas é credencial — o token do link de relatório, `code`/`state`
 * do callback OAuth. Sem conta, organização, IP ou corpo: o id basta para
 * achar o resto, e nada aqui vira dado pessoal no log.
 *
 * Fica fora o `/health`, que o monitor da VPS chama o tempo todo, e o preflight
 * `OPTIONS`, que não tem efeito.
 */
const SILENT_PATHS = new Set(['/api/v1/health']);

@Injectable()
export class AccessLogMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HttpAccess');

  use(req: RequestWithCorrelation, res: Response, next: NextFunction): void {
    const path = pathOf(req.originalUrl ?? req.url ?? '');

    if (req.method === 'OPTIONS' || SILENT_PATHS.has(path)) {
      next();
      return;
    }

    const startedAt = process.hrtime.bigint();

    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const line =
        `http method=${req.method} path=${path} status=${res.statusCode} ` +
        `ms=${ms.toFixed(1)} correlationId=${req.correlationId ?? '-'}`;

      // 5xx em error: é o que precisa aparecer num filtro de nível sem ruído.
      if (res.statusCode >= 500) this.logger.error(line);
      else if (res.statusCode >= 400) this.logger.warn(line);
      else this.logger.log(line);
    });

    next();
  }
}

/** Caminho sem query nem fragmento. */
export function pathOf(rawUrl: string): string {
  const end = rawUrl.search(/[?#]/);
  return end === -1 ? rawUrl : rawUrl.slice(0, end);
}
