import { PlansModule } from 'src/modules/plans/plans.module';
import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { AIModule } from 'src/modules/ai/ai.module';
import { AdScoringModule } from 'src/modules/ad-scoring/ad-scoring.module';
import { IntegrationsModule } from 'src/modules/integrations/integrations.module';
import { SubscriptionAccessModule } from 'src/modules/subscriptions/access/subscription-access.module';
import { MediaModule } from 'src/shared/infrastructure/media/media.module';
import { StorageModule } from 'src/shared/infrastructure/storage/storage.module';
import { CreativeThumbnailService } from './application/services/creative-thumbnail.service';
import { AnalysisEnrichmentService } from './application/services/analysis-enrichment.service';
import { AnalysisProductionService } from './application/services/analysis-production.service';
import { AnalysisQuotaService } from './application/services/analysis-quota.service';
import { CopyContextBuilder } from './application/services/copy-context.builder';
import { CopyGenerationService } from './application/services/copy-generation.service';
import { AnalyzeAdUseCase } from './application/use-cases/analyze-ad.usecase';
import { GenerateCopyUseCase } from './application/use-cases/generate-copy.usecase';
import { CopyReadUseCases } from './application/use-cases/copy-read.usecases';
import { CopyGenerator } from './domain/ports/copy-generator.port';
import { RoutedCopyGenerator } from './infrastructure/ai/routed-copy-generator';
import { CopyGenerationsRepositoryInterface } from './domain/ports/copy-generations.repository';
import { CopyGenerationsPrismaRepository } from './infrastructure/database/prisma/copy-generations-prisma.repository';
import {
  AdCopyController,
  CopyStudioController,
} from './infrastructure/http/controllers/copy-studio.controller';
import { CopyAppliedListener } from './infrastructure/events/copy-applied.listener';
import { COPY_STUDIO_QUEUE } from './infrastructure/queues/copy-studio.constants';
import { CopyStudioDispatcher } from './infrastructure/queues/copy-studio.dispatcher';
import { CopyStudioWorker } from './infrastructure/queues/copy-studio.worker';
import { AnalysisNarrator } from './domain/ports/analysis-narrator.port';
import { RoutedAnalysisNarrator } from './infrastructure/ai/routed-analysis-narrator';
import { CreativeAnalysisRepositoryInterface } from './domain/ports/creative-analysis.repository';
import { CreativeThumbnailRepositoryInterface } from './domain/ports/creative-thumbnail.repository';
import { VideoProcessingPortInterface } from './domain/ports/video-processing.port';
import { CreativeAnalysisPrismaRepository } from './infrastructure/database/prisma/creative-analysis-prisma.repository';
import { CreativeThumbnailPrismaRepository } from './infrastructure/database/prisma/creative-thumbnail-prisma.repository';
import { AdAnalysisController } from './infrastructure/http/controllers/ad-analysis.controller';
import { CreativeLabController } from './infrastructure/http/controllers/creative-lab.controller';
import { FfmpegVideoProcessor } from './infrastructure/media/ffmpeg-video.processor';
import { CreativeThumbnailScheduler } from './infrastructure/schedulers/creative-thumbnail.scheduler';

/**
 * `creative-lab` — o extrator de frame religado (D7) e as regras de §11.3/§11.4.
 *
 * **As calculadoras de score saíram daqui em A2-S4.** Viviam em `domain/scoring/`
 * desde o v1 e agora moram em `ad-scoring/domain/scoring/`, que é o módulo que as
 * consome. A migração foi verificada por uma suíte escrita **antes** dela: as
 * mesmas asserções passavam no endereço antigo e passam no novo, o que é a única
 * forma de "sem mudança de lógica" ser verificável em vez de prometida.
 *
 * O que ficou é o que pertence aqui: a comparação entre anúncios do mesmo
 * criativo e os candidatos de substituição — funções puras, sem DI, por isso
 * ausentes desta lista — e o extrator de frame, para o criativo de vídeo
 * **sincronizado** que a plataforma entregou sem `thumbnailUrl`.
 *
 * **`CreativeThumbnailScheduler` é o consumidor que faltava.** O serviço e o
 * extrator existiam prontos desde A2-S4/S9 sem nenhum chamador — o comentário
 * anterior deste módulo já os chamava de "religados", mas religar sem gatilho
 * não move um byte. É o scheduler que fecha o laço.
 */
@Module({
  imports: [
    PlansModule,
    SubscriptionAccessModule,
    StorageModule,
    MediaModule,
    /**
     * A2-S9 — `POST /ads/{id}/analyze` parte dos componentes do score (§11.3),
     * e entra pelo **port de leitura** `AdScoreReader` (D2). Importar o serviço
     * de cálculo é bloqueado por teste próprio.
     */
    AdScoringModule,
    IntegrationsModule,
    /**
     * A2-S9 — o enriquecimento por IA. `AIModule` traz o roteamento
     * multi-provider **e** a contabilidade de custo (C9), que mudou de casa
     * neste sprint: ela é da plataforma, não de `ad-scoring`.
     */
    AIModule,
    /**
     * A fila do vínculo entre execução e variação.
     *
     * Existe por uma regra, não por gosto: `EventEmitter2` é síncrono, e um
     * handler que gravasse inline faria `perform-action` esperar o Copy Studio
     * para terminar de executar uma ação em mídia paga (⊕10).
     */
    BullModule.registerQueue({ name: COPY_STUDIO_QUEUE }),
  ],
  controllers: [
    CreativeLabController,
    AdAnalysisController,
    AdCopyController,
    CopyStudioController,
  ],
  providers: [
    CreativeThumbnailService,
    AnalyzeAdUseCase,
    AnalysisEnrichmentService,
    AnalysisQuotaService,
    AnalysisProductionService,
    /**
     * O Copy Studio — §11.4 do passo 5 em diante.
     *
     * A ordem dos três é a formulação de P4 desta feature: `CopyContextBuilder`
     * lê o mundo, `CopyGenerationService` decide se a chamada pode acontecer e
     * registra o que ela custou, e `CopyGenerator` — a única peça autoral —
     * escreve as palavras. As sugestões que ele recebe já saíram prontas de
     * regra pura em `AnalyzeAdUseCase`.
     */
    CopyContextBuilder,
    CopyGenerationService,
    GenerateCopyUseCase,
    CopyReadUseCases,
    /**
     * O elo que fecha o laço: qual variação foi de fato ao ar.
     *
     * Consumidor de evento, e não chamada do executor: um `REPLACE_COPY` com
     * texto digitado à mão não tem variação nenhuma por trás, e `platform-actions`
     * não deve conhecer o Copy Studio — é a mesma inversão já recusada em
     * relação a `recommendations`.
     */
    CopyAppliedListener,
    CopyStudioDispatcher,
    CopyStudioWorker,
    { provide: CopyGenerator, useClass: RoutedCopyGenerator },
    {
      provide: CopyGenerationsRepositoryInterface,
      useClass: CopyGenerationsPrismaRepository,
    },
    { provide: AnalysisNarrator, useClass: RoutedAnalysisNarrator },
    {
      provide: CreativeAnalysisRepositoryInterface,
      useClass: CreativeAnalysisPrismaRepository,
    },
    { provide: VideoProcessingPortInterface, useClass: FfmpegVideoProcessor },
    {
      provide: CreativeThumbnailRepositoryInterface,
      useClass: CreativeThumbnailPrismaRepository,
    },
    CreativeThumbnailScheduler,
  ],
  exports: [
    CreativeThumbnailService,
    /**
     * Exportado para `recommendations` saber se existe variante escolhida — é
     * o que faz `REPLACE_COPY` deixar de ser declarada inviável por falta de
     * parâmetro com origem.
     */
    CopyGenerationsRepositoryInterface,
  ],
})
export class CreativeLabModule {}
