import { Injectable } from '@nestjs/common';
import { BackofficeAuditLogService } from 'src/modules/audit/application/backoffice-audit-log.service';
import type { Operator } from 'src/modules/auth/domain/entities';
import { SavedView } from 'src/modules/preferences/domain/entities';
import { SavedViewsRepositoryInterface } from 'src/modules/preferences/domain/ports';
import { CreateSavedViewInputDto, SavedViewOutputDto } from '../dtos';
import { toSavedViewOutput } from '../preferences.presenter';
import { assertScreenAvailable } from '../saved-view-access';

@Injectable()
export class CreateSavedViewUseCase {
  constructor(
    private readonly viewsRepository: SavedViewsRepositoryInterface,
    private readonly audit: BackofficeAuditLogService,
  ) {}

  async execute(
    operator: Operator,
    input: CreateSavedViewInputDto,
  ): Promise<SavedViewOutputDto> {
    assertScreenAvailable(operator, input.screen);

    const view = SavedView.create({ ...input, operatorId: operator.id });
    await this.viewsRepository.save(view);

    const output = toSavedViewOutput(view);

    await this.audit.record({
      actor: operator,
      action: 'saved_view.created',
      subjectType: 'SAVED_VIEW',
      subjectId: view.id,
      after: output,
    });

    return output;
  }
}
