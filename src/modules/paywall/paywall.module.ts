import { Module } from '@nestjs/common';
import { AnalysisScopeModule } from 'src/modules/analysis-scope/analysis-scope.module';
import { IntegrationsModule } from 'src/modules/integrations/integrations.module';
import { RecommendationsModule } from 'src/modules/recommendations/recommendations.module';
import { SubscriptionAccessModule } from 'src/modules/subscriptions/access/subscription-access.module';
import { WasteModule } from 'src/modules/waste/waste.module';
import { GetUpgradeSummaryUseCase } from './application/get-upgrade-summary.usecase';
import { UpgradeSummaryController } from './infrastructure/http/controllers/upgrade-summary.controller';

/**
 * A tela de contratação, e só ela.
 *
 * ## Por que é um módulo próprio
 *
 * O lugar óbvio seria `subscriptions/access`, que já é dono de `/api/v1/me`.
 * Não dá: `RecommendationsModule` importa `SubscriptionAccessModule` (precisa do
 * guard), então ler recomendações de dentro do módulo de acesso fecharia um
 * ciclo. Um módulo à parte resolve mantendo a seta numa direção só —
 * **paywall → inteligência**, nunca o contrário.
 *
 * ## O que ele não faz
 *
 * Não consulta Prisma. Os números saem dos ports de leitura que `waste` e
 * `recommendations` já exportam, porque a soma correta do desperdício (máximo
 * por anúncio, jamais soma de `waste_items`) mora lá — e uma consulta nova aqui
 * seria a dupla contagem de A2-S5 reaparecendo na única tela que fala em
 * dinheiro com quem ainda não é cliente.
 */
@Module({
  imports: [
    AnalysisScopeModule,
    SubscriptionAccessModule,
    WasteModule,
    RecommendationsModule,
    IntegrationsModule,
  ],
  controllers: [UpgradeSummaryController],
  providers: [GetUpgradeSummaryUseCase],
})
export class PaywallModule {}
