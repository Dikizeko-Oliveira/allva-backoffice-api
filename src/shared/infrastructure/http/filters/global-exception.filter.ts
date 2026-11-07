import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { RequestWithCorrelation } from 'src/shared/infrastructure/context/correlation-id.middleware';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);
  private readonly isProduction = process.env.NODE_ENV === 'production';

  catch(exception: unknown, host: ArgumentsHost) {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<RequestWithCorrelation>();
    const correlationId = request.correlationId;

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      response.status(status).json(
        typeof exceptionResponse === 'object'
          ? exceptionResponse
          : {
              message: exceptionResponse,
              statusCode: status,
              path: request.url,
              timestamp: new Date().toISOString(),
            },
      );
      return;
    }

    const { status, message } = this.mapDomainError(exception);

    // Unexpected (non-domain) errors are the only place a raw exception surfaces.
    // Log them server-side with their stack so operators can diagnose 500s.
    if (status === HttpStatus.INTERNAL_SERVER_ERROR) {
      // Caminho, não `url`: a query nunca vai ao log. E o id da requisição,
      // o mesmo do `allva-api`, para ligar o relato ao 500 (GAP-058).
      this.logger.error(
        `Unhandled exception on ${request.method} ${request.path} correlationId=${correlationId ?? '-'}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).json({
      // Never leak internal error details to clients in production.
      message:
        status === HttpStatus.INTERNAL_SERVER_ERROR && this.isProduction
          ? 'Internal server error'
          : message,
      statusCode: status,
      path: request.url,
      timestamp: new Date().toISOString(),
      // Aditivo (GAP-058): o mesmo valor do header X-Correlation-Id.
      ...(correlationId ? { correlationId } : {}),
    });
  }

  private mapDomainError(exception: unknown) {
    if (exception instanceof Error) {
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        message: exception.message || 'Internal server error',
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    };
  }
}
