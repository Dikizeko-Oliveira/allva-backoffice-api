import { Module } from '@nestjs/common';
import { PlatformHttpClient } from './infrastructure/platform-http.client';
import { PlatformRateLimiterService } from './infrastructure/platform-rate-limiter.service';

/**
 * `platform-clients` — o transporte compartilhado por plataforma (§5.2).
 *
 * **Não importa `integrations` nem `platform-actions`** (§5.3 r.8). Precisa de
 * credencial, mas declara o que precisa (`PlatformCredentialProvider`) e quem a
 * tem obedece ao contrato. Sem essa inversão o módulo nasceria circular e o
 * token bucket de R4 — a razão de ele existir — seria impossível.
 */
@Module({
  providers: [PlatformRateLimiterService, PlatformHttpClient],
  exports: [PlatformRateLimiterService, PlatformHttpClient],
})
export class PlatformClientsModule {}
