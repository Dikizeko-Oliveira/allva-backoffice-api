import { PlansModule } from 'src/modules/plans/plans.module';
import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { AdScoringModule } from 'src/modules/ad-scoring/ad-scoring.module';
import { AdsModule } from 'src/modules/ads/ads.module';
import { IntegrationsModule } from 'src/modules/integrations/integrations.module';
import { SubscriptionAccessModule } from 'src/modules/subscriptions/access/subscription-access.module';
import { SyncModule } from 'src/modules/sync/sync.module';
import { DetectWasteService } from './application/services/detect-waste.service';
import { WasteReconciliationService } from './application/services/waste-reconciliation.service';
import { ResolveAdWasteUseCase } from './application/use-cases/resolve-ad-waste.usecase';
import { ResolveWasteItemUseCase } from './application/use-cases/resolve-waste-item.usecase';
import {
  GetAdEvidenceUseCase,
  GetAdWasteUseCase,
  GetEvidenceSummaryUseCase,
  GetWasteItemUseCase,
  GetWasteRollupUseCase,
  GetWasteSummaryUseCase,
  ListWasteByAdUseCase,
  ListWasteItemsUseCase,
} from './application/use-cases/waste-read-use-cases';
import { WasteItemsRepositoryInterface } from './domain/ports/waste-items.repository';
import { WasteReadRepositoryInterface } from './domain/ports/waste-read.repository';
import { WasteSettingsReader } from './domain/ports/waste-settings.reader';
import { WasteTargetsRepositoryInterface } from './domain/ports/waste-targets.repository';
import { WasteItemsPrismaRepository } from './infrastructure/database/prisma/waste-items-prisma.repository';
import { WasteReadPrismaRepository } from './infrastructure/database/prisma/waste-read-prisma.repository';
import { WasteSettingsPrismaReader } from './infrastructure/database/prisma/waste-settings-prisma.reader';
import { WasteTargetsPrismaRepository } from './infrastructure/database/prisma/waste-targets-prisma.repository';
import { AdWasteController } from './infrastructure/http/controllers/ad-waste.controller';
import { WasteController } from './infrastructure/http/controllers/waste.controller';
import { WASTE_QUEUE } from './infrastructure/queues/waste.constants';
import { WasteDispatcher } from './infrastructure/queues/waste.dispatcher';
import { WasteWorker } from './infrastructure/queues/waste.worker';
import { WasteScheduler } from './infrastructure/schedulers/waste.scheduler';

/**
 * `waste` — o Waste Detector v2 de §10.
 *
 * **Depende de `ad-scoring` pelo port de leitura, nunca pelo cálculo** (D2,
 * §5.3 r.2). Quatro dos dez detectores consomem componentes do `AdScore`, e o
 * que entra aqui é o `AdScoreReader` — o contrato. O teste de arquitetura cobra
 * que ninguém importe `ScoreAdAccountService`.
 *
 * **Não conhece `creative-lab`** (r.3) e **não conhece `recommendations`** (r.4):
 * quem compõe achado, score e análise criativa num plano é o motor de
 * recomendação, e ele é downstream dos três.
 *
 * Importa `SyncModule` pelo `JobCoordinatorService`: os dois ciclos diários
 * rodam sob lease de `JobRun` e dependem de janelas anteriores (§8.8). A
 * coordenação nasceu em A2-S3 e é reutilizada, não reimplementada — dois
 * mecanismos para a mesma exclusão mútua é como ela deixa de existir.
 *
 * **Exporta o port de leitura** para que `analytics` produza seus rollups pela
 * view `open_waste` em vez de reimplementar a agregação — e reintroduzir a dupla
 * contagem dentro do módulo que existe para não tê-la.
 */
@Module({
  imports: [
    // `ListWasteItemsUseCase` recusa oportunidades fora do plano.
    PlansModule,
    SubscriptionAccessModule,
    IntegrationsModule,
    AdsModule,
    AdScoringModule,
    SyncModule,
    BullModule.registerQueue({ name: WASTE_QUEUE }),
  ],
  controllers: [WasteController, AdWasteController],
  providers: [
    DetectWasteService,
    WasteReconciliationService,
    GetWasteSummaryUseCase,
    ListWasteItemsUseCase,
    GetWasteItemUseCase,
    GetAdWasteUseCase,
    GetAdEvidenceUseCase,
    GetEvidenceSummaryUseCase,
    GetWasteRollupUseCase,
    ListWasteByAdUseCase,
    ResolveWasteItemUseCase,
    ResolveAdWasteUseCase,
    WasteDispatcher,
    WasteWorker,
    WasteScheduler,
    {
      provide: WasteTargetsRepositoryInterface,
      useClass: WasteTargetsPrismaRepository,
    },
    {
      provide: WasteItemsRepositoryInterface,
      useClass: WasteItemsPrismaRepository,
    },
    {
      provide: WasteReadRepositoryInterface,
      useClass: WasteReadPrismaRepository,
    },
    { provide: WasteSettingsReader, useClass: WasteSettingsPrismaReader },
  ],
  // O read model **e** a régua sob a qual ele foi lido. Exportar só o primeiro
  // faria `analytics` inventar a janela ativa da organização — e um agregado
  // declarando uma janela que não é a que o produziu é P7 violado por descuido.
  /**
   * `WasteItemsRepositoryInterface` sai daqui desde A2-S9 por causa de §9.5
   * passo 8: aplicar uma recomendação resolve **todos** os achados vinculados a
   * ela, e quem sabe quais são é `recommendations`. A alternativa — `waste`
   * escutando `recommendation.applied` — poria a resolução num handler
   * assíncrono, e o usuário veria o achado aberto por segundos depois de agir
   * sobre ele.
   */
  exports: [
    // Sai para o `onboarding-chain` — ver ad-scoring.module.ts.
    WasteDispatcher,
    WasteReadRepositoryInterface,
    WasteSettingsReader,
    WasteItemsRepositoryInterface,
  ],
})
export class WasteModule {}
