import { PlansModule } from 'src/modules/plans/plans.module';
import { Module } from '@nestjs/common';
import { AdLineageOriginReader } from './domain/ports/ad-lineage-origin.reader';
import { AdLineageOriginPrismaReader } from './infrastructure/database/prisma/ad-lineage-origin-prisma.reader';
import { IntegrationsModule } from 'src/modules/integrations/integrations.module';
import { SubscriptionAccessModule } from 'src/modules/subscriptions/access/subscription-access.module';
import {
  GetAdAnalysisUseCase,
  GetAdHistoryUseCase,
  GetAdSeriesUseCase,
  GetAdUseCase,
  ListAdsUseCase,
} from './application/use-cases/ad-read-use-cases';
import { AdContextRepositoryInterface } from './domain/ports/ad-context.repository';
import { AdMetricsRepositoryInterface } from './domain/ports/ad-metrics.repository';
import { AdsRepositoryInterface } from './domain/ports/ads.repository';
import { AdContextPrismaRepository } from './infrastructure/database/prisma/ad-context-prisma.repository';
import { AdMetricsPrismaRepository } from './infrastructure/database/prisma/ad-metrics-prisma.repository';
import { AdsPrismaRepository } from './infrastructure/database/prisma/ads-prisma.repository';
import { AdContextController } from './infrastructure/http/controllers/ad-context.controller';
import { AdsController } from './infrastructure/http/controllers/ads.controller';

/**
 * `ads` — a base do grafo de dependências (§5.3 r.1).
 *
 * **Não importa nenhum módulo de inteligência**, e é o teste de arquitetura que
 * garante: `ad-scoring`, `waste`, `recommendations`, `creative-lab` e
 * `platform-actions` dependem de `ads`, nunca o contrário. A única importação
 * aqui é `integrations`, e só para o `OwnerScopeResolverService` — a resolução
 * de tenancy que o repositório inteiro já usa.
 *
 * **Rota ≠ módulo** (D3): o prefixo `/ads` é compartilhado com módulos que
 * chegam depois — `POST /ads/{id}/actions` é de `platform-actions`,
 * `POST /ads/{id}/sync` é de `sync` —, mas nenhum verbo de escrita nasce aqui.
 */
@Module({
  imports: [PlansModule, SubscriptionAccessModule, IntegrationsModule],
  controllers: [AdsController, AdContextController],
  providers: [
    {
      provide: AdLineageOriginReader,
      useClass: AdLineageOriginPrismaReader,
    },
    ListAdsUseCase,
    GetAdUseCase,
    GetAdSeriesUseCase,
    GetAdHistoryUseCase,
    GetAdAnalysisUseCase,
    { provide: AdsRepositoryInterface, useClass: AdsPrismaRepository },
    {
      provide: AdContextRepositoryInterface,
      useClass: AdContextPrismaRepository,
    },
    {
      provide: AdMetricsRepositoryInterface,
      useClass: AdMetricsPrismaRepository,
    },
  ],
  exports: [
    AdLineageOriginReader,
    AdMetricsRepositoryInterface,
    AdsRepositoryInterface,
  ],
})
export class AdsModule {}
