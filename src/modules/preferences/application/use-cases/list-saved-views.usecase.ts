import { Injectable } from '@nestjs/common';
import type { Operator } from 'src/modules/auth/domain/entities';
import { SavedViewsRepositoryInterface } from 'src/modules/preferences/domain/ports';
import { ListSavedViewsQueryDto, SavedViewOutputDto } from '../dtos';
import { toSavedViewOutput } from '../preferences.presenter';
import { assertScreenAvailable, canUseScreen } from '../saved-view-access';

@Injectable()
export class ListSavedViewsUseCase {
  constructor(
    private readonly viewsRepository: SavedViewsRepositoryInterface,
  ) {}

  async execute(
    operator: Operator,
    query: ListSavedViewsQueryDto,
  ): Promise<SavedViewOutputDto[]> {
    if (query.screen) assertScreenAvailable(operator, query.screen);

    const views = await this.viewsRepository.listVisibleTo(
      operator.id,
      query.screen,
    );

    return views
      .filter((view) => canUseScreen(operator, view.screen))
      .map(toSavedViewOutput);
  }
}
