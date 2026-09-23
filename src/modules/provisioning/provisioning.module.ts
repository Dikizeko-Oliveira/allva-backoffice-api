import { Module } from '@nestjs/common';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import { AccountsPrismaRepository } from 'src/modules/accounts/infrastructure/database/prisma/accounts-prisma.repository';
import { PasswordHasherInterface } from 'src/modules/auth/domain/ports/password-hasher.port';
import { ArgonPasswordHasher } from 'src/modules/auth/infrastructure/services/argon-password-hasher.provider';
import {
  OrganizationsRepositoryInterface,
  OrganizationUsersRepositoryInterface,
} from 'src/modules/organizations/domain/ports';
import { OrganizationsPrismaRepository } from 'src/modules/organizations/infrastructure/database/prisma/organizations-prisma.repository';
import { OrganizationUsersPrismaRepository } from 'src/modules/organizations/infrastructure/database/prisma/organization-users-prisma.repository';
import { PlansRepositoryInterface } from 'src/modules/plans/domain/ports';
import { PlansPrismaRepository } from 'src/modules/plans/infrastructure/database/prisma/plan-prisma.repository';
import { EnterpriseProvisioningService } from './application/enterprise-provisioning.service';
import { OrganizationProvisioningService } from './application/organization-provisioning.service';

@Module({
  providers: [
    EnterpriseProvisioningService,
    OrganizationProvisioningService,
    {
      provide: AccountsRepositoryInterface,
      useClass: AccountsPrismaRepository,
    },
    {
      provide: PlansRepositoryInterface,
      useClass: PlansPrismaRepository,
    },
    {
      provide: PasswordHasherInterface,
      useClass: ArgonPasswordHasher,
    },
    {
      provide: OrganizationsRepositoryInterface,
      useClass: OrganizationsPrismaRepository,
    },
    {
      provide: OrganizationUsersRepositoryInterface,
      useClass: OrganizationUsersPrismaRepository,
    },
  ],
  exports: [EnterpriseProvisioningService, OrganizationProvisioningService],
})
export class ProvisioningModule {}
