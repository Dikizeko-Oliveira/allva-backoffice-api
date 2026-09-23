import { Module } from '@nestjs/common';
import {
  ConvertContractDraftUseCase,
  CreateContractDraftUseCase,
  GetContractDraftUseCase,
  ListContractDraftsUseCase,
  UpdateContractDraftUseCase,
} from './application/use-cases';
import {
  ContractDraftsRepositoryInterface,
  ProductContractsGatewayInterface,
} from './domain/ports';
import { ContractDraftsPrismaRepository } from './infrastructure/database/prisma/contract-drafts-prisma.repository';
import { ContractDraftsController } from './infrastructure/http/controllers/contract-drafts.controller';
import { AllvaApiContractsGateway } from './infrastructure/providers/allva-api-contracts.gateway';

@Module({
  controllers: [ContractDraftsController],
  providers: [
    ListContractDraftsUseCase,
    GetContractDraftUseCase,
    CreateContractDraftUseCase,
    UpdateContractDraftUseCase,
    ConvertContractDraftUseCase,
    {
      provide: ContractDraftsRepositoryInterface,
      useClass: ContractDraftsPrismaRepository,
    },
    {
      provide: ProductContractsGatewayInterface,
      useClass: AllvaApiContractsGateway,
    },
  ],
})
export class ContractDraftsModule {}
