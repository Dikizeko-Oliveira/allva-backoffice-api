import { Module } from '@nestjs/common';
import { AnalysisScopeModule } from 'src/modules/analysis-scope/analysis-scope.module';
import { AdScoringModule } from 'src/modules/ad-scoring/ad-scoring.module';
import { WasteModule } from 'src/modules/waste/waste.module';
import { RecommendationsModule } from 'src/modules/recommendations/recommendations.module';
import { SubscriptionAccessModule } from 'src/modules/subscriptions/access/subscription-access.module';
import { FirstSyncChainListener } from './infrastructure/events/first-sync-chain.listener';

/**
 * O módulo que liga "conectei uma conta" a "recebi um diagnóstico".
 *
 * **Existe para não fechar ciclo.** `ad-scoring`, `waste` e `recommendations`
 * importam `SyncModule` pelo lease de `JobRun`, então o `sync` não pode chamá-los
 * de volta. Este módulo importa os quatro e **não é importado por nenhum** — a
 * dependência anda num sentido só, e a orquestração fica num lugar onde ela é
 * legível como orquestração, não escondida dentro do ingest.
 *
 * Não tem controller, port nem repositório de propósito: a única coisa que ele
 * faz é reagir a um evento e enfileirar, na ordem, o que o ciclo noturno faria
 * de madrugada — e só para organização que o ciclo noturno varreria.
 */
@Module({
  imports: [
    AnalysisScopeModule,
    AdScoringModule,
    WasteModule,
    RecommendationsModule,
    SubscriptionAccessModule,
  ],
  providers: [FirstSyncChainListener],
})
export class OnboardingChainModule {}
