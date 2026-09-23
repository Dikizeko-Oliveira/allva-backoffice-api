import { Module } from '@nestjs/common';
import { OrganizationsModule } from 'src/modules/organizations/organizations.module';
import { PlanEntitlementService } from 'src/modules/plans/application/plan-entitlement.service';
import { PlansPrismaRepository } from 'src/modules/plans/infrastructure/database/prisma/plan-prisma.repository';
import { PlansRepositoryInterface } from 'src/modules/plans/domain/ports';
import {
  CreatePlanUseCase,
  ListPlansUseCase,
} from 'src/modules/plans/application/use-cases';
import { PlansController } from 'src/modules/plans/infrastructure/http/controllers/plans.controller';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import { AccountsPrismaRepository } from 'src/modules/accounts/infrastructure/database/prisma/accounts-prisma.repository';

/**
 * O dono do catálogo, e agora também de quem o aplica.
 *
 * `PlanEntitlementService` nasceu em `platform-actions`, onde havia um único
 * consumidor. Com integrações e relatórios passando a perguntar a mesma coisa,
 * mantê-lo lá obrigaria os dois a importar o módulo de **escrita em mídia paga**
 * para descobrir o próprio plano — e uma seta dessas é a que ninguém consegue
 * remover depois.
 */
@Module({
  imports: [OrganizationsModule],
  controllers: [PlansController],
  providers: [
    PlanEntitlementService,
    CreatePlanUseCase,
    ListPlansUseCase,
    {
      provide: PlansRepositoryInterface,
      useClass: PlansPrismaRepository,
    },
    {
      provide: AccountsRepositoryInterface,
      useClass: AccountsPrismaRepository,
    },
  ],
  // `PlansRepositoryInterface` sai daqui porque o cadastro precisa recusar o
  // plano negociado antes de criar a conta — e quem sabe se um plano é
  // negociado é o catálogo.
  exports: [PlanEntitlementService, PlansRepositoryInterface],
})
export class PlansModule {}
