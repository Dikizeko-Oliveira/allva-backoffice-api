import { Module } from '@nestjs/common';
import { TicketSlaTrackerService } from './application/services/ticket-sla-tracker.service';
import {
  AssignSupportTicketUseCase,
  CreateSlaPolicyUseCase,
  GetSupportMetricsUseCase,
  GetSupportTicketUseCase,
  ListSlaPoliciesUseCase,
  ListSupportQueueUseCase,
  UpdateSlaPolicyUseCase,
} from './application/use-cases';
import {
  SlaPoliciesRepositoryInterface,
  SupportTicketsGatewayInterface,
  TicketAssignmentEventsRepositoryInterface,
  TicketSlaSnapshotsRepositoryInterface,
} from './domain/ports';
import { SlaPoliciesPrismaRepository } from './infrastructure/database/prisma/sla-policies-prisma.repository';
import { TicketAssignmentEventsPrismaRepository } from './infrastructure/database/prisma/ticket-assignment-events-prisma.repository';
import { TicketSlaSnapshotsPrismaRepository } from './infrastructure/database/prisma/ticket-sla-snapshots-prisma.repository';
import { SlaPoliciesController } from './infrastructure/http/controllers/sla-policies.controller';
import { SupportMetricsController } from './infrastructure/http/controllers/support-metrics.controller';
import { SupportQueueController } from './infrastructure/http/controllers/support-queue.controller';
import { AllvaApiSupportTicketsGateway } from './infrastructure/providers/allva-api-support-tickets.gateway';

/**
 * Processo interno de atendimento: SLA, fila enriquecida, repasses e métricas.
 * O chamado em si é do `allva-api`.
 */
@Module({
  controllers: [
    SupportQueueController,
    SlaPoliciesController,
    SupportMetricsController,
  ],
  providers: [
    TicketSlaTrackerService,
    ListSupportQueueUseCase,
    GetSupportTicketUseCase,
    AssignSupportTicketUseCase,
    ListSlaPoliciesUseCase,
    CreateSlaPolicyUseCase,
    UpdateSlaPolicyUseCase,
    GetSupportMetricsUseCase,
    {
      provide: SupportTicketsGatewayInterface,
      useClass: AllvaApiSupportTicketsGateway,
    },
    {
      provide: SlaPoliciesRepositoryInterface,
      useClass: SlaPoliciesPrismaRepository,
    },
    {
      provide: TicketSlaSnapshotsRepositoryInterface,
      useClass: TicketSlaSnapshotsPrismaRepository,
    },
    {
      provide: TicketAssignmentEventsRepositoryInterface,
      useClass: TicketAssignmentEventsPrismaRepository,
    },
  ],
})
export class SupportModule {}
