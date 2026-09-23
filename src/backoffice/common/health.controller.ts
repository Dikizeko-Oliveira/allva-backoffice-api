import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class BackofficeHealthController {
  @Get()
  health() {
    return { status: 'ok', service: 'allva-backoffice-api' };
  }
}
