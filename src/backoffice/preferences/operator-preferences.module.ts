import { Module } from '@nestjs/common';
import { OperatorPreferencesController } from './operator-preferences.controller';

@Module({
  controllers: [OperatorPreferencesController],
})
export class OperatorPreferencesModule {}
