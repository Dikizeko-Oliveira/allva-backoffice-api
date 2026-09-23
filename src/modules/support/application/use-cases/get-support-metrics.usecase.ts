import { Injectable } from '@nestjs/common';
import { assertPlatformPermission } from 'src/modules/auth/application/platform-authorization';
import type { Operator } from 'src/modules/auth/domain/entities';
import {
  TicketAssignmentEventsRepositoryInterface,
  TicketSlaSnapshotsRepositoryInterface,
} from 'src/modules/support/domain/ports';
import { SupportMetricsOutputDto, SupportMetricsQueryDto } from '../dtos';

@Injectable()
export class GetSupportMetricsUseCase {
  constructor(
    private readonly assignmentEventsRepository: TicketAssignmentEventsRepositoryInterface,
    private readonly snapshotsRepository: TicketSlaSnapshotsRepositoryInterface,
  ) {}

  async execute(
    operator: Operator,
    query: SupportMetricsQueryDto,
  ): Promise<SupportMetricsOutputDto> {
    assertPlatformPermission(operator, 'support:read');

    const [assigned, compliance] = await Promise.all([
      this.assignmentEventsRepository.count({
        from: query.from,
        to: query.to,
        toOperatorId: query.operatorId,
      }),
      this.snapshotsRepository.compliance({
        from: query.from,
        to: query.to,
        assigneeId: query.operatorId,
      }),
    ]);

    return {
      firstResponse: { medianMinutes: null, p90Minutes: null },
      resolution: { medianMinutes: null, p90Minutes: null },
      volume: { assigned, resolved: null, reopened: null },
      withinSlaPercentage:
        compliance.total === 0
          ? null
          : Math.round(
              ((compliance.total - compliance.breached) / compliance.total) *
                10_000,
            ) / 100,
    };
  }
}
