import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { Response } from 'express';
import { DomainError, renderDomainError } from './domain-error';

/**
 * Traduz `DomainError` no envelope de erro de §7.0.4.
 *
 * Registrado **depois** do `GlobalExceptionFilter` em `main.ts`: o Nest avalia
 * os filtros globais na ordem inversa da registração, então o último registrado
 * é o primeiro consultado. Como essa é uma sutileza fácil de desfazer sem
 * perceber, o `GlobalExceptionFilter` também sabe renderizar `DomainError` —
 * pela mesma função pura. A ordem vira otimização, não requisito de correção.
 */
@Catch(DomainError)
export class DomainErrorFilter implements ExceptionFilter<DomainError> {
  catch(exception: DomainError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body } = renderDomainError(exception);

    response.status(status).json(body);
  }
}
