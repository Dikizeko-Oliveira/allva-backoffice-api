import { PlansModule } from 'src/modules/plans/plans.module';
import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { AdsModule } from 'src/modules/ads/ads.module';
import { AIModule } from 'src/modules/ai/ai.module';
import { SubscriptionAccessModule } from 'src/modules/subscriptions/access/subscription-access.module';
import { SyncModule } from 'src/modules/sync/sync.module';
import { ScoreAdAccountService } from './application/services/score-ad-account.service';
import { ScoreEnrichmentService } from './application/services/score-enrichment.service';
import { AdNarrativeGenerator } from './domain/ports/ad-narrative.generator';
import { RoutedAdNarrativeGenerator } from './infrastructure/ai/routed-ad-narrative.generator';
import { AdScoreReader } from './domain/ports/ad-score-reader.port';
import { AdScoresRepositoryInterface } from './domain/ports/ad-scores.repository';
import { AdScoringTargetsRepositoryInterface } from './domain/ports/ad-scoring-targets.repository';
import { AdScoreReaderPrismaAdapter } from './infrastructure/database/prisma/ad-score-reader-prisma.adapter';
import { AdScoresPrismaRepository } from './infrastructure/database/prisma/ad-scores-prisma.repository';
import { AdScoringTargetsPrismaRepository } from './infrastructure/database/prisma/ad-scoring-targets-prisma.repository';
import { AD_SCORING_QUEUE } from './infrastructure/queues/ad-scoring.constants';
import { AdScoringDispatcher } from './infrastructure/queues/ad-scoring.dispatcher';
import { AdScoringWorker } from './infrastructure/queues/ad-scoring.worker';
import { AdScoringScheduler } from './infrastructure/schedulers/ad-scoring.scheduler';

/**
 * `ad-scoring` — o AI Score de §12.
 *
 * **Exporta o `AdScoreReader`, nunca o serviço de cálculo** (D2). É a resolução
 * da impossibilidade lógica da primeira redação: `ads` expõe read models mas não
 * os calcula, e `waste`/`creative-lab` consomem o score "nunca importando
 * serviços de `ad-scoring`". Um port de **leitura** preserva a intenção sem a
 * contradição — o contrato é público, o cálculo continua invisível de fora, e o
 * teste de arquitetura cobra que ninguém importe `ScoreAdAccountService`.
 *
 * Importa `SyncModule` pelo `JobCoordinatorService`: o ciclo diário roda sob
 * lease de `JobRun` e depende de `ads-ingest-full` da mesma janela (§8.8). A
 * coordenação nasceu em A2-S3 e é reutilizada, não reimplementada — dois
 * mecanismos para a mesma exclusão mútua é como ela deixa de existir.
 */
@Module({
  imports: [
    PlansModule,
    AdsModule,
    SyncModule,
    // A política de varredura: o cron só pontua organização com acesso aberto.
    SubscriptionAccessModule,
    // §12.6 — o roteamento multi-provider ficou intacto e sem consumidor desde
    // A2-S1. Este é o consumidor, e ele entra **por cima** do score: P4 manda o
    // determinístico primeiro, e a narrativa é campo a mais.
    AIModule,
    BullModule.registerQueue({ name: AD_SCORING_QUEUE }),
  ],
  providers: [
    ScoreAdAccountService,
    ScoreEnrichmentService,
    { provide: AdNarrativeGenerator, useClass: RoutedAdNarrativeGenerator },
    AdScoringDispatcher,
    AdScoringWorker,
    AdScoringScheduler,
    {
      provide: AdScoresRepositoryInterface,
      useClass: AdScoresPrismaRepository,
    },
    {
      provide: AdScoringTargetsRepositoryInterface,
      useClass: AdScoringTargetsPrismaRepository,
    },
    { provide: AdScoreReader, useClass: AdScoreReaderPrismaAdapter },
  ],
  // `AdScoringDispatcher` sai para o `onboarding-chain`, que acorda a cadeia
  // na primeira sincronização da conta em vez de esperar o cron das 05:30.
  exports: [AdScoreReader, AdScoringDispatcher],
})
export class AdScoringModule {}
