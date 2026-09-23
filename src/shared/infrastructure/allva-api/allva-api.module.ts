import { Global, Module } from '@nestjs/common';
import { AllvaApiClient } from './allva-api.client';

/**
 * Global porque todo módulo que fala com o produto implementa o próprio
 * gateway sobre o mesmo transporte — um `imports` em cada um só repetiria isto.
 */
@Global()
@Module({
  providers: [AllvaApiClient],
  exports: [AllvaApiClient],
})
export class AllvaApiModule {}
