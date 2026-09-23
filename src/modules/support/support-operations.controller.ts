import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { CurrentOperator } from '../auth/current-operator.decorator';
import { OperatorContext } from '../auth/operator-context';
import { RequirePlatformPermissions } from '../auth/require-platform-permissions.decorator';
import { SupportOperationsService } from './support-operations.service';

type AssignmentBody = {
  toOperatorId?: string | null;
  assigneeId?: string | null;
  reason?: string | null;
};

@Controller()
export class SupportOperationsController {
  constructor(private readonly support: SupportOperationsService) {}

  @Get('support/queue')
  @RequirePlatformPermissions('support:read')
  listQueue(
    @CurrentOperator() operator: OperatorContext,
    @Query() query: Record<string, string | number | boolean | undefined>,
  ) {
    return this.support.listQueue(operator, query);
  }

  @Get('support/tickets/:ticketId')
  @RequirePlatformPermissions('support:read')
  getTicket(
    @CurrentOperator() operator: OperatorContext,
    @Param('ticketId') ticketId: string,
  ) {
    return this.support.getEnrichedTicket(operator, ticketId);
  }

  @Post('support/tickets/:ticketId/assignment')
  @RequirePlatformPermissions('support:manage')
  assignTicket(
    @CurrentOperator() operator: OperatorContext,
    @Param('ticketId') ticketId: string,
    @Body() body: AssignmentBody,
    @Req() request: Request,
  ) {
    return this.support.assignTicket({
      operator,
      ticketId,
      toOperatorId: body.toOperatorId ?? body.assigneeId ?? null,
      reason: body.reason,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
  }

  @Get('support/sla-policies')
  @RequirePlatformPermissions('support:read')
  listPolicies() {
    return this.support.listPolicies();
  }

  @Post('support/sla-policies')
  @RequirePlatformPermissions('settings:manage')
  createPolicy(
    @CurrentOperator() operator: OperatorContext,
    @Body()
    body: {
      priority: string;
      category?: string | null;
      firstResponseMinutes: number;
      resolutionMinutes: number;
      businessHours?: boolean;
      active?: boolean;
    },
  ) {
    return this.support.createPolicy({ ...body, operator });
  }

  @Patch('support/sla-policies/:id')
  @RequirePlatformPermissions('settings:manage')
  updatePolicy(
    @CurrentOperator() operator: OperatorContext,
    @Param('id') id: string,
    @Body()
    body: Partial<{
      priority: string;
      category: string | null;
      firstResponseMinutes: number;
      resolutionMinutes: number;
      businessHours: boolean;
      active: boolean;
    }>,
  ) {
    return this.support.updatePolicy(id, { ...body, operator });
  }

  @Get('support/metrics')
  @RequirePlatformPermissions('support:read')
  metrics(@Query() query: { from?: string; to?: string; operatorId?: string }) {
    return this.support.metrics(query);
  }
}
