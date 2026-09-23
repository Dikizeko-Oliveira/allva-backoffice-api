import { Injectable } from '@nestjs/common';
import type { Operator } from 'src/modules/auth/domain/entities';
import {
  severityOrder,
  supportSignalsVisibleTo,
  UNACKNOWLEDGED_ALERTS_KEY,
} from 'src/modules/operations-hub/domain/attention-signals';
import { AttentionCountsReaderInterface } from 'src/modules/operations-hub/domain/ports';
import { AttentionSignalDto, OperatorAttentionOutputDto } from '../dtos';

/**
 * `GET /api/v1/hub/attention` — as pendências do processo interno para o Operations
 * Hub.
 *
 * ## Quem entra
 *
 * Qualquer operador: o hub é a primeira tela de todos. A rota não exige uma
 * permissão específica — o que muda de um operador para outro é quais sinais
 * voltam, e isso é decidido aqui, por `operator.can`. Sinal de outra área não
 * aparece nem zerado.
 */
@Injectable()
export class GetOperatorAttentionUseCase {
  constructor(private readonly countsReader: AttentionCountsReaderInterface) {}

  async execute(
    operator: Operator,
    now: Date = new Date(),
  ): Promise<OperatorAttentionOutputDto> {
    const visible = supportSignalsVisibleTo((permission) =>
      operator.can(permission),
    );

    const [supportCounts, alertCounts] = await Promise.all([
      this.countsReader.countSupport(
        visible.map((signal) => signal.key),
        operator.id,
        now,
      ),
      this.countsReader.countUnacknowledgedAlerts(operator.permissions),
    ]);

    const signals: AttentionSignalDto[] = [
      ...visible.map((signal) => ({
        key: signal.key,
        permission: signal.permission,
        severity: signal.severity,
        count: supportCounts[signal.key] ?? null,
      })),
      ...alertCounts.map((alert) => ({
        key: UNACKNOWLEDGED_ALERTS_KEY,
        permission: alert.permission,
        severity: alert.severity,
        count: alert.count,
      })),
    ];

    // `sort` é estável: dentro da mesma severidade vale a ordem do catálogo.
    signals.sort(
      (a, b) => severityOrder(a.severity) - severityOrder(b.severity),
    );

    return { generatedAt: now.toISOString(), signals };
  }
}
