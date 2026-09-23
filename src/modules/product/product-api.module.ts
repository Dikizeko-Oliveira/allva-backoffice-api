import { Global, Module } from '@nestjs/common';
import { ProductApiClient } from './product-api.client';

@Global()
@Module({
  providers: [ProductApiClient],
  exports: [ProductApiClient],
})
export class ProductApiModule {}
