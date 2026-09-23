import { Module } from '@nestjs/common';
import { OrganizationsModule } from 'src/modules/organizations/organizations.module';
import { SubscriptionAccessModule } from 'src/modules/subscriptions/access/subscription-access.module';
import { AnalysisScopeService } from 'src/modules/analysis-scope/application/analysis-scope.service';
import { AnalysisScopeRepositoryInterface } from 'src/modules/analysis-scope/domain/ports/analysis-scope.repository';
import { AnalysisScopePrismaRepository } from 'src/modules/analysis-scope/infrastructure/database/prisma/analysis-scope-prisma.repository';
import { AnalysisScopeScheduler } from 'src/modules/analysis-scope/infrastructure/schedulers/analysis-scope.scheduler';

/**
 * O dono de `Ad.analysisEligibleAt` — e a razão de ser um módulo, não uma pasta
 * dentro de `ads`.
 *
 * §5.4 dá a cada grupo de colunas de `ads` **um** dono que escreve, e `ads`
 * não é dono de nenhum: ele lê o agregado. A primeira versão deste código
 * morava em `src/modules/ads/` e fazia `prisma.ad.updateMany` — o teste de
 * propriedade de escrita reprovou, com razão.
 *
 * O dono também não podia ser `ad-scoring` nem `waste`: os dois **consomem** a
 * régua, e pôr a decisão dentro de um deles faria o outro depender do módulo
 * vizinho para saber o que analisar. Um oitavo dono, que só decide escopo, é o
 * que mantém os dois motores simétricos diante da mesma resposta.
 *
 * Importa `SubscriptionAccessModule` pela política de varredura: a régua da
 * noite só passa por organização com acesso aberto.
 */
@Module({
  imports: [OrganizationsModule, SubscriptionAccessModule],
  providers: [
    AnalysisScopeService,
    AnalysisScopeScheduler,
    {
      provide: AnalysisScopeRepositoryInterface,
      useClass: AnalysisScopePrismaRepository,
    },
  ],
  exports: [AnalysisScopeRepositoryInterface, AnalysisScopeService],
})
export class AnalysisScopeModule {}
