import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, map } from 'rxjs';
import { EnvelopedResult, ResponseMeta } from './response-meta';
import {
  RESPONSE_ENVELOPE_METADATA,
  ResponseEnvelopeOptions,
} from './response-envelope.decorator';

/**
 * Aplica o envelope de sucesso de §7.0.1 e cobra P7 onde ele vale.
 *
 * Duas portas de entrada, e nenhuma delas afeta rota legada:
 *
 * 1. o handler devolve `envelope(data, meta)` — vira `{ data, meta }`;
 * 2. a rota carrega `@ResponseEnvelope()` e devolve um valor cru — vira
 *    `{ data: valor, meta: {} }`.
 *
 * Qualquer outra coisa passa intacta. Sem isso, registrar o interceptor
 * globalmente reescreveria a resposta de todos os módulos existentes.
 *
 * **A cobrança de P7.** Uma rota marcada como `intelligence` que devolva número
 * derivado sem `asOf` e sem `provenance` é um número sem procedência — o que o
 * princípio existe para impedir. Fora de produção isso **falha**, porque é onde
 * o teste roda e onde o erro é barato. Em produção, registra e deixa passar:
 * derrubar uma rota que funciona por causa de um campo de metadados ausente
 * troca um problema de observabilidade por uma indisponibilidade.
 */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ResponseEnvelopeInterceptor.name);
  private readonly isProduction = process.env.NODE_ENV === 'production';

  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.getAllAndOverride<
      ResponseEnvelopeOptions | undefined
    >(RESPONSE_ENVELOPE_METADATA, [context.getHandler(), context.getClass()]);

    return next.handle().pipe(
      map((result: unknown) => {
        if (result instanceof EnvelopedResult) {
          // `EnvelopedResult` é genérico, então o `instanceof` estreita para
          // `EnvelopedResult<any>` e `data` viraria `any` daqui para a frente.
          const enveloped = result as EnvelopedResult<unknown>;
          this.assertProvenance(context, options, enveloped.meta);
          return { data: enveloped.data, meta: enveloped.meta };
        }

        if (!options) return result;

        this.assertProvenance(context, options, {});
        return { data: result, meta: {} as ResponseMeta };
      }),
    );
  }

  private assertProvenance(
    context: ExecutionContext,
    options: ResponseEnvelopeOptions | undefined,
    meta: ResponseMeta,
  ): void {
    if (!options?.intelligence) return;
    if (meta.asOf && meta.provenance) return;

    const route = `${context.getClass().name}.${context.getHandler().name}`;
    const missing = [
      meta.asOf ? null : 'meta.asOf',
      meta.provenance ? null : 'meta.provenance',
    ]
      .filter(Boolean)
      .join(', ');
    const message = `${route} é rota de inteligência e respondeu sem ${missing} (P7).`;

    if (this.isProduction) {
      this.logger.error(message);
      return;
    }

    throw new Error(message);
  }
}
