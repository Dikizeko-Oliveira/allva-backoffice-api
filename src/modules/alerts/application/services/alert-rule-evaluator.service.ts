import { Injectable, Logger } from '@nestjs/common';
import {
  type AlertRuleDecision,
  decideAlertRule,
  isLocallyEvaluatedSource,
  type LocallyEvaluatedSource,
} from 'src/modules/alerts/domain/alert-evaluation';
import { AlertEvent } from 'src/modules/alerts/domain/entities';
import {
  AlertEventsRepositoryInterface,
  AlertRulesRepositoryInterface,
} from 'src/modules/alerts/domain/ports';
import { AttentionCountsReaderInterface } from 'src/modules/operations-hub/domain/ports';

export type AlertEvaluationSummary = Record<AlertRuleDecision['kind'], number>;

/**
 * Os sinais avaliados aqui não dependem de operador; o parâmetro do leitor só
 * existe para `support.assigned_to_me_waiting`, que o job não avalia.
 */
const NO_OPERATOR = '';

/**
 * Avalia as regras de alerta ativas e grava os disparos (GAP-044).
 *
 * Roda pelo `AlertEvaluationScheduler`, sem operador e sem requisição — por
 * isso é serviço e não use case: não há quem autorizar. Quem vê o disparo é
 * decidido na leitura, pela `requiredPermission` da regra.
 *
 * Canal (`EMAIL`/`SLACK`) e `quiet_hours` não entram: o envio ainda não
 * existe, e o evento aparece no painel e no hub (`alerts.unacknowledged`).
 */
@Injectable()
export class AlertRuleEvaluatorService {
  private readonly logger = new Logger(AlertRuleEvaluatorService.name);

  constructor(
    private readonly rules: AlertRulesRepositoryInterface,
    private readonly events: AlertEventsRepositoryInterface,
    private readonly counts: AttentionCountsReaderInterface,
  ) {}

  async evaluate(now: Date = new Date()): Promise<AlertEvaluationSummary> {
    const summary: AlertEvaluationSummary = {
      FIRE: 0,
      HOLD_OPEN_EVENT: 0,
      BELOW_THRESHOLD: 0,
      NOT_EVALUATED: 0,
    };

    const active = (await this.rules.list()).filter((rule) => rule.active);
    const sources = [
      ...new Set(
        active
          .map((rule) => rule.source)
          .filter((source): source is LocallyEvaluatedSource =>
            isLocallyEvaluatedSource(source),
          ),
      ),
    ];

    const counts =
      sources.length > 0
        ? await this.counts.countSupport(sources, NO_OPERATOR, now)
        : {};

    for (const rule of active) {
      const local = isLocallyEvaluatedSource(rule.source);
      const decision = decideAlertRule({
        source: rule.source,
        threshold: rule.threshold,
        count: local ? counts[rule.source] : undefined,
        hasOpenEvent: local && (await this.events.hasOpenForRule(rule.id)),
      });

      summary[decision.kind] += 1;

      if (decision.kind !== 'FIRE') continue;

      await this.events.save(
        AlertEvent.create(
          {
            ruleId: rule.id,
            requiredPermission: rule.requiredPermission,
            source: rule.source,
            severity: decision.severity,
            payload: {
              count: decision.count,
              threshold: rule.threshold,
              evaluatedAt: now.toISOString(),
            },
          },
          now,
        ),
      );
      this.logger.log(
        `alert.fired ruleId=${rule.id} source=${rule.source} count=${decision.count}`,
      );
    }

    return summary;
  }
}
