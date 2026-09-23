import { Module } from '@nestjs/common';
import {
  CreateSavedViewUseCase,
  DeleteSavedViewUseCase,
  GetOperatorPreferenceUseCase,
  ListSavedViewsUseCase,
  UpdateOperatorPreferenceUseCase,
  UpdateSavedViewUseCase,
} from './application/use-cases';
import {
  OperatorPreferencesRepositoryInterface,
  SavedViewsRepositoryInterface,
} from './domain/ports';
import { OperatorPreferencesPrismaRepository } from './infrastructure/database/prisma/operator-preferences-prisma.repository';
import { SavedViewsPrismaRepository } from './infrastructure/database/prisma/saved-views-prisma.repository';
import { OperatorPreferencesController } from './infrastructure/http/controllers/operator-preferences.controller';
import { SavedViewsController } from './infrastructure/http/controllers/saved-views.controller';

@Module({
  controllers: [OperatorPreferencesController, SavedViewsController],
  providers: [
    GetOperatorPreferenceUseCase,
    UpdateOperatorPreferenceUseCase,
    ListSavedViewsUseCase,
    CreateSavedViewUseCase,
    UpdateSavedViewUseCase,
    DeleteSavedViewUseCase,
    {
      provide: OperatorPreferencesRepositoryInterface,
      useClass: OperatorPreferencesPrismaRepository,
    },
    {
      provide: SavedViewsRepositoryInterface,
      useClass: SavedViewsPrismaRepository,
    },
  ],
})
export class PreferencesModule {}
