import { Global, Module } from '@nestjs/common';
import { RequestContextService } from './request-context.service';

/**
 * Global so the middleware that establishes the per-request context and the
 * services that read it can both inject RequestContextService without an
 * explicit import.
 */
@Global()
@Module({
  providers: [RequestContextService],
  exports: [RequestContextService],
})
export class RequestContextModule {}
