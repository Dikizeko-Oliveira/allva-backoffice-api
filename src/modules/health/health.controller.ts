import { Controller, Get, HttpStatus, Logger, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { Response } from 'express';
import { Public } from 'src/modules/auth/infrastructure/http/decorators/public.decorator';
import { NoThrottle } from 'src/shared/infrastructure/http/throttling/throttle-policies';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import {
  FfmpegBinaryLocator,
  FfmpegStatus,
} from 'src/shared/infrastructure/media/ffmpeg-binary.locator';
import { BILLING_RECONCILIATION_QUEUE } from 'src/modules/subscriptions/access/infrastructure/jobs/billing-reconciliation.processor';

/**
 * The health probe needs *a* Bull queue to ping Redis through; it borrows the
 * billing reconciliation one rather than registering a queue of its own.
 *
 * Re-exported from the canonical constant instead of repeating the literal
 * `'billing-reconciliation'`, which is what it used to do — renaming the queue
 * on the billing side would have left the health check pinging a queue nobody
 * else used, and it would still have reported `redis: ok`.
 */
export const HEALTH_QUEUE = BILLING_RECONCILIATION_QUEUE;

@ApiTags('Health')
@Controller('/api/v1/health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    @InjectQueue(HEALTH_QUEUE) private readonly queue: Queue,
    private readonly prisma: PrismaService,
    private readonly ffmpeg: FfmpegBinaryLocator,
  ) {}

  @Get()
  @Public()
  /**
   * Never rate limited.
   *
   * The load balancer probes this route and reacts to the HTTP status (runbook,
   * "Operação"). A 429 is not a 200, so throttling the probe would pull a healthy
   * instance out of rotation — concentrating traffic on the remaining ones until
   * they trip the same limit. The failure cascades in the direction of the outage
   * it was meant to prevent.
   */
  @NoThrottle()
  @ApiOperation({ summary: 'Health check do sistema' })
  async check(@Res({ passthrough: true }) res: Response) {
    const [database, redis, videoPreview] = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
      this.checkVideoPreview(),
    ]);

    // Only `services` decides the HTTP status. `optional` components are
    // accessory (PLAN.md Sprint 5.5 / P-3): a missing ffmpeg binary must be
    // *visible* without marking the whole instance unhealthy and pulling it out
    // of the load balancer.
    const allOk = database === 'ok' && redis === 'ok';

    // Return 503 when any dependency is down so load balancers / uptime probes
    // that key on the HTTP status treat this instance as unhealthy.
    res.status(allOk ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);

    return {
      status: allOk ? 'ok' : 'degraded',
      services: { database, redis },
      optional: { videoPreview },
    };
  }

  private async checkDatabase(): Promise<'ok' | 'unavailable'> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'ok';
    } catch (error) {
      this.logger.error('Database health check failed', error);
      return 'unavailable';
    }
  }

  /**
   * `disabled` (flag off), `ok` (binary runnable) or `unavailable` (enabled but
   * no runnable binary — every preview job is going to fail). Reported, never
   * fatal. The reason is logged rather than returned: `/health` is public.
   */
  private async checkVideoPreview(): Promise<FfmpegStatus> {
    const probe = await this.ffmpeg.probe();

    if (probe.status === 'unavailable') {
      this.logger.error(`Video preview health check failed: ${probe.reason}`);
    }

    return probe.status;
  }

  private async checkRedis(): Promise<'ok' | 'unavailable'> {
    try {
      // The `await` is load-bearing despite what the types say. Bull declares
      // `client: Redis`, so `await-thenable` calls this redundant — but the
      // client is resolved lazily and can still be a pending (or rejected)
      // promise when the probe runs, which is exactly the "Redis is down" case
      // this check exists for. Dropping the await made a rejected client throw
      // an unhandled rejection instead of returning `unavailable`.
      // eslint-disable-next-line @typescript-eslint/await-thenable
      const client = await this.queue.client;
      await client.ping();
      return 'ok';
    } catch (error) {
      this.logger.error('Redis health check failed', error);
      return 'unavailable';
    }
  }
}
