import { Module } from '@nestjs/common';
import { OperatorIntrospectionService } from './operator-introspection.service';

@Module({
  providers: [OperatorIntrospectionService],
  exports: [OperatorIntrospectionService],
})
export class BackofficeAuthModule {}
