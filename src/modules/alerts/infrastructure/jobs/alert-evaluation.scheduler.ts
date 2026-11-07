import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { AlertRuleEvaluatorService } from 'src/modules/alerts/application/services/alert-rule-evaluator.service';
import { EnvService } from 'src/shared/infrastructure/config/env.service';

/** O intervalo de `docs/backoffice-api.md` §4.4 e §4.5. */
export const ALERT_EVALUATION_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Dispara a avaliação das regras de alerta a cada 5 minutos (GAP-044).
 *
 * `setInterval` e não uma fila: o backoffice-api roda numa instância só
 * (decisão de 2026-11-05), e a avaliação é idempotente — o evento aberto
 * deduplica. Uma volta que ainda não terminou impede a próxima de começar.
 * O timer é `unref`: não segura o processo no desligamento.
 *
 * `ALERT_EVALUATION_ENABLED=false` desliga. Falha de uma volta é logada e a
 * seguinte tenta de novo; nunca derruba o processo.
 */
@Injectable()
export class AlertEvaluationScheduler
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(AlertEvaluationScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly evaluator: AlertRuleEvaluatorService,
    private readonly env: EnvService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.env.get('ALERT_EVALUATION_ENABLED')) {
      this.logger.log(
        'Alert evaluation disabled (ALERT_EVALUATION_ENABLED=false)',
      );
      return;
    }

    this.timer = setInterval(
      () => void this.tick(),
      ALERT_EVALUATION_INTERVAL_MS,
    );
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Uma volta. Pública para o teste, que não espera cinco minutos. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const summary = await this.evaluator.evaluate();
      if (summary.FIRE > 0) {
        this.logger.log(`alert.evaluation fired=${summary.FIRE}`);
      }
    } catch (error) {
      this.logger.error(
        'alert.evaluation_failed',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.running = false;
    }
  }
}
