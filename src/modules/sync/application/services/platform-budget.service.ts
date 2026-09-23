import { Injectable, Logger } from '@nestjs/common';
import { PlatformRateLimiterService } from 'src/modules/platform-clients/infrastructure/platform-rate-limiter.service';

/**
 * O orçamento de chamadas compartilhado entre ① ingest e ② refresh (R4, §8.3).
 *
 * O token bucket vive em `platform-clients` e é **por integração**: leitura e
 * escrita da mesma credencial competem pelo mesmo saldo, porque a plataforma as
 * conta juntas. Este serviço é só a política de espera — quem não tem saldo
 * **espera**, não insiste: um laço de tentativa queima exatamente a cota que o
 * balde existe para proteger.
 *
 * O teto é por processo, não global. Com N réplicas o limite efetivo é
 * N×limite, o que continua verdadeiro depois de A2-S3 e está registrado como
 * dívida em `platform-rate-limiter.service.ts`. A mitigação em vigor é o lease
 * de `JobRun`: uma janela de ingest tem um dono só, então as réplicas não
 * disputam a mesma conta — disputam contas diferentes da mesma credencial, que é
 * o caso raro.
 */
@Injectable()
export class PlatformBudgetService {
  private readonly logger = new Logger(PlatformBudgetService.name);

  constructor(private readonly limiter: PlatformRateLimiterService) {}

  /** Espera até haver saldo, e então executa. */
  async spend<T>(
    integrationId: string,
    call: () => Promise<T>,
    cost = 1,
  ): Promise<T> {
    await this.awaitBudget(integrationId, cost);
    return call();
  }

  private async awaitBudget(
    integrationId: string,
    cost: number,
  ): Promise<void> {
    // Teto de espera para não segurar o lease indefinidamente: se o balde não
    // liberar em ~30 s, é melhor a janela falhar e ser retomada do que o worker
    // ficar preso sem heartbeat útil.
    const deadline = Date.now() + 30_000;

    for (;;) {
      const { allowed, retryAfterMs } = this.limiter.tryAcquire(
        integrationId,
        cost,
      );
      if (allowed) return;

      if (Date.now() + retryAfterMs > deadline) {
        this.logger.warn(
          `platform.budget_exhausted integrationId=${integrationId} retryAfterMs=${retryAfterMs}`,
        );
        return;
      }

      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(50, retryAfterMs)),
      );
    }
  }
}
