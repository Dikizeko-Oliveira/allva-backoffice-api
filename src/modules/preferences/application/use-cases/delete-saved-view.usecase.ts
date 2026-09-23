import { Injectable } from '@nestjs/common';
import { BackofficeAuditLogService } from 'src/modules/audit/application/backoffice-audit-log.service';
import type { Operator } from 'src/modules/auth/domain/entities';
import { SavedViewsRepositoryInterface } from 'src/modules/preferences/domain/ports';
import { DeleteSavedViewOutputDto } from '../dtos';
import { toSavedViewOutput } from '../preferences.presenter';
import { assertScreenAvailable, findOwnedView } from '../saved-view-access';

@Injectable()
export class DeleteSavedViewUseCase {
  constructor(
    private readonly viewsRepository: SavedViewsRepositoryInterface,
    private readonly audit: BackofficeAuditLogService,
  ) {}

  async execute(
    operator: Operator,
    id: string,
  ): Promise<DeleteSavedViewOutputDto> {
    const view = await findOwnedView(this.viewsRepository, operator, id);
    assertScreenAvailable(operator, view.screen);

    await this.viewsRepository.delete(id);

    await this.audit.record({
      actor: operator,
      action: 'saved_view.deleted',
      subjectType: 'SAVED_VIEW',
      subjectId: id,
      before: toSavedViewOutput(view),
    });

    return { deleted: true };
  }
}
