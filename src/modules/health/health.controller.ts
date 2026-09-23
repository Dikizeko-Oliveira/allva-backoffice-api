import { Controller, Get, HttpStatus, Logger, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from 'src/modules/auth/infrastructure/http/decorators/public.decorator';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

/**
 * Sonda do balanceador. Só o banco próprio decide o status: o `allva-api` fora
 * derruba as rotas que dependem dele (com `503` explicado), mas não é motivo
 * para tirar esta instância de rotação — outra instância estaria igualmente
 * sem ele.
 */
@ApiTags('Health')
@Controller('/api/v1/health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'Health check do serviço' })
  async check(@Res({ passthrough: true }) res: Response) {
    const database = await this.checkDatabase();
    const ok = database === 'ok';

    res.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);

    return {
      status: ok ? 'ok' : 'degraded',
      service: 'allva-backoffice-api',
      services: { database },
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
}
