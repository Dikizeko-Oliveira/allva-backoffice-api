import { Injectable, NotFoundException } from '@nestjs/common';
import { AlertEventsRepositoryInterface } from 'src/modules/alerts/domain/ports';
import { BackofficeAuditLogService } from 'src/modules/audit/application/backoffice-audit-log.service';
import { platformPermissionDenied } from 'src/modules/auth/application/platform-authorization';
import type { Operator } from 'src/modules/auth/domain/entities';
import { toAlertEventOutput } from '../alerts.presenter';
import { AlertEventOutputDto } from '../dtos';

@Injectable()
export class AcknowledgeAlertEventUseCase {
  constructor(
    private readonly eventsRepository: AlertEventsRepositoryInterface,
    private readonly audit: BackofficeAuditLogService,
  ) {}

  async execute(operator: Operator, id: string): Promise<AlertEventOutputDto> {
    const event = await this.eventsRepository.findById(id);

    if (!event) {
      throw new NotFoundException({
        code: 'ALERT_EVENT_NOT_FOUND',
        message: 'Alert event not found',
      });
    }

    if (!operator.can(event.requiredPermission)) {
      throw platformPermissionDenied(event.requiredPermission);
    }

    if (event.isAcknowledged) return toAlertEventOutput(event);

    event.acknowledge(operator.id);
    await this.eventsRepository.saveAcknowledgement(event);

    const output = toAlertEventOutput(event);

    await this.audit.record({
      actor: operator,
      action: 'alert_event.acknowledged',
      subjectType: 'ALERT_EVENT',
      subjectId: id,
      after: output,
    });

    return output;
  }
}
