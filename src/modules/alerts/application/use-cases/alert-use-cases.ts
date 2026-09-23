import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { OwnerScopeResolverService } from 'src/modules/integrations/application/services/owner-scope-resolver.service';
import {
  AlertDTO,
  AlertListQuery,
  AlertsRepositoryInterface,
  CreateAlertInput,
} from 'src/modules/alerts/domain/ports/alerts.repository';
import { alertFingerprint } from 'src/modules/alerts/domain/alert-delivery-policy';
import { AlertNotifierService } from 'src/modules/alerts/application/services/alert-notifier.service';

@Injectable()
export class CreateAlertUseCase {
  private readonly logger = new Logger(CreateAlertUseCase.name);

  constructor(
    private readonly repo: AlertsRepositoryInterface,
    private readonly notifier: AlertNotifierService,
  ) {}

  /**
   * Raises an alert and, when it earns one, delivers an email (PLAN.md M-2).
   *
   * Deduplicates first: waste detection runs daily and re-reports persistent
   * conditions, so a recurrence bumps the existing open alert instead of creating a
   * second one. Only a genuinely new alert reaches the notifier — that is what keeps
   * a week-long waste condition at one email instead of seven.
   */
  async execute(input: CreateAlertInput): Promise<AlertDTO> {
    const fingerprint = alertFingerprint(input);

    const { alert, created } = await this.repo.createOrRecur({
      ...input,
      fingerprint,
    });

    if (!created) {
      this.logger.log(
        `alert.recurrence alertId=${alert.id} occurrences=${alert.occurrences} — not re-notifying`,
      );
      return alert;
    }

    // Never throws: an alert that exists in-app with a failed email is degraded,
    // whereas an exception here would fail the pipeline that raised it.
    await this.notifier.notify(alert);

    return alert;
  }
}

@Injectable()
export class ListAlertsUseCase {
  private readonly logger = new Logger(ListAlertsUseCase.name);

  constructor(
    private readonly repo: AlertsRepositoryInterface,
    private readonly scope: OwnerScopeResolverService,
  ) {}

  async execute(
    accountId: string,
    query: Omit<AlertListQuery, 'organizationId'>,
  ) {
    const owner = await this.scope.resolveForAccount(accountId);

    // Alerta é da organização desde A2-S1. Sem organização selecionada não há
    // lista a devolver — e uma lista vazia é a resposta honesta, não um erro:
    // quem opera no workspace pessoal genuinamente não tem alertas.
    if (!owner.organizationId) return { data: [], total: 0 };

    this.logger.log(`Listing alerts for organization ${owner.organizationId}`);
    return this.repo.list({ organizationId: owner.organizationId, ...query });
  }
}

/** A tela de detalhes: um alerta, escopado à organização de quem pede. */
@Injectable()
export class GetAlertUseCase {
  constructor(
    private readonly repo: AlertsRepositoryInterface,
    private readonly scope: OwnerScopeResolverService,
  ) {}

  async execute(accountId: string, alertId: string) {
    const organizationId = await resolveOrganizationOrFail(
      this.scope,
      accountId,
    );
    const alert = await this.repo.findById(alertId, organizationId);
    if (!alert) throw new NotFoundException('Alert not found');
    return alert;
  }
}

@Injectable()
export class MarkAlertReadUseCase {
  constructor(
    private readonly repo: AlertsRepositoryInterface,
    private readonly scope: OwnerScopeResolverService,
  ) {}

  async execute(accountId: string, alertId: string) {
    const organizationId = await resolveOrganizationOrFail(
      this.scope,
      accountId,
    );
    const updated = await this.repo.markRead(alertId, organizationId);
    if (!updated) throw new NotFoundException('Alert not found');
    return updated;
  }
}

@Injectable()
export class MarkAllAlertsReadUseCase {
  constructor(
    private readonly repo: AlertsRepositoryInterface,
    private readonly scope: OwnerScopeResolverService,
  ) {}

  async execute(accountId: string) {
    const organizationId = await resolveOrganizationOrFail(
      this.scope,
      accountId,
    );
    const count = await this.repo.markAllRead(organizationId);
    return { marked: count };
  }
}

/**
 * The user hides an alert. Distinct from resolve: dismissing says "I have seen this
 * and do not want it in my queue", not "the problem is gone".
 */
@Injectable()
export class DismissAlertUseCase {
  constructor(
    private readonly repo: AlertsRepositoryInterface,
    private readonly scope: OwnerScopeResolverService,
  ) {}

  async execute(accountId: string, alertId: string) {
    const organizationId = await resolveOrganizationOrFail(
      this.scope,
      accountId,
    );
    const updated = await this.repo.dismiss(alertId, organizationId);
    if (!updated) throw new NotFoundException('Alert not found');
    return updated;
  }
}

/**
 * The underlying condition ended ("encerramento"). Closing the alert also reopens the
 * dedupe window: if the same problem is detected again later it is new information,
 * and gets its own alert and its own email.
 */
@Injectable()
export class ResolveAlertUseCase {
  constructor(
    private readonly repo: AlertsRepositoryInterface,
    private readonly scope: OwnerScopeResolverService,
  ) {}

  async execute(accountId: string, alertId: string) {
    const organizationId = await resolveOrganizationOrFail(
      this.scope,
      accountId,
    );
    const updated = await this.repo.resolve(alertId, organizationId);
    if (!updated) throw new NotFoundException('Alert not found');
    return updated;
  }
}

/**
 * Toda escrita de alerta exige organização: a coluna é NOT NULL desde A2-S1 e a
 * ação de um workspace pessoal não tem alerta a alterar. `NotFoundException`
 * (e não 403) porque, do ponto de vista de quem pede, o alerta realmente não
 * existe naquele escopo — e a alternativa vazaria a informação de que existe em
 * outro.
 */
async function resolveOrganizationOrFail(
  scope: OwnerScopeResolverService,
  accountId: string,
): Promise<string> {
  const owner = await scope.resolveForAccount(accountId);
  if (!owner.organizationId) throw new NotFoundException('Alert not found');
  return owner.organizationId;
}
