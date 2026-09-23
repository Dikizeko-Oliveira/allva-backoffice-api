import { Injectable } from '@nestjs/common';
import { BackofficeAuditLogService } from 'src/modules/audit/application/backoffice-audit-log.service';
import type { Operator } from 'src/modules/auth/domain/entities';
import { SavedViewsRepositoryInterface } from 'src/modules/preferences/domain/ports';
import { SavedViewOutputDto, UpdateSavedViewInputDto } from '../dtos';
import { toSavedViewOutput } from '../preferences.presenter';
import { assertScreenAvailable, findOwnedView } from '../saved-view-access';

@Injectable()
export class UpdateSavedViewUseCase {
  constructor(
    private readonly viewsRepository: SavedViewsRepositoryInterface,
    private readonly audit: BackofficeAuditLogService,
  ) {}

  async execute(
    operator: Operator,
    id: string,
    input: UpdateSavedViewInputDto,
  ): Promise<SavedViewOutputDto> {
    const view = await findOwnedView(this.viewsRepository, operator, id);
    // O operador pode ter perdido a permissão da tela depois de salvar a visão.
    assertScreenAvailable(operator, view.screen);

    const before = toSavedViewOutput(view);

    view.update(input);
    await this.viewsRepository.update(view);

    const after = toSavedViewOutput(view);

    await this.audit.record({
      actor: operator,
      action: 'saved_view.updated',
      subjectType: 'SAVED_VIEW',
      subjectId: id,
      before,
      after,
    });

    return after;
  }
}
