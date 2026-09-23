import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PlatformRoleService } from 'src/modules/accounts/application/services/platform-role.service';
import { AuditLogService } from 'src/modules/audit/application/audit-log.service';
import {
  ContractAmendment,
  EnterpriseContract,
  type AmendmentChanges,
} from 'src/modules/contracts/domain/entities';
import { ContractAmendmentsRepositoryInterface } from 'src/modules/contracts/domain/ports/contract-amendments.repository';
import { EnterpriseContractsRepositoryInterface } from 'src/modules/contracts/domain/ports/enterprise-contracts.repository';
import {
  AmendmentView,
  toAmendmentView,
} from '../contract-amendment.presenter';
import { ContractAmendmentApplier } from '../services/contract-amendment-applier';
import { ContractUsageService } from '../services/contract-usage.service';

export type CreateAmendmentInput = {
  contractId: string;
  effectiveAt: Date;
  reason: string;
  changes: AmendmentChanges;
};

/**
 * O aditivo: expandir, reduzir ou mudar o valor no meio da vigência.
 *
 * Criar e aplicar são dois momentos. Criar é registrar o documento; **aplicar**
 * é escrever na cota da organização e nos termos do contrato, e só acontece
 * quando `effectiveAt` chega — porque é assim que se negocia: "a partir de
 * janeiro passam a ser 250 assentos".
 *
 * Um aditivo com data de hoje é aplicado na mesma chamada, para o operador não
 * ter de esperar o job por uma expansão que o cliente já comprou. Um datado
 * para o futuro fica pendente, e `ApplyDueAmendmentsUseCase` o escreve no dia —
 * pela mesma escrita, que mora em `ContractAmendmentApplier`.
 */
@Injectable()
export class AmendContractUseCase {
  constructor(
    private readonly contracts: EnterpriseContractsRepositoryInterface,
    private readonly amendments: ContractAmendmentsRepositoryInterface,
    private readonly platformRole: PlatformRoleService,
    private readonly applier: ContractAmendmentApplier,
    private readonly usage: ContractUsageService,
    private readonly auditLog: AuditLogService,
  ) {}

  async execute(
    input: CreateAmendmentInput,
    actorId: string,
  ): Promise<AmendmentView> {
    await this.platformRole.assertPermission(actorId, 'billing:manage');

    const contract = await this.load(input.contractId);

    if (!contract.organizationId) {
      /**
       * Antes da ativação não há nada provisionado, e mudança é correção: se
       * edita o contrato. Abrir o aditivo aqui daria dois caminhos para a mesma
       * coisa, e o histórico do cliente passaria a conter documentos que só
       * consertam digitação.
       */
      throw new ConflictException({
        code: 'CONTRACT_NOT_ACTIVATED',
        message: 'A contract is amended after activation; before it, edit it',
      });
    }

    const amendment = ContractAmendment.create({
      contractId: contract.id,
      organizationId: contract.organizationId,
      number: await this.amendments.nextAmendmentNumber(
        contract.id,
        contract.contractNumber,
      ),
      effectiveAt: input.effectiveAt,
      reason: input.reason,
      changes: input.changes,
      createdBy: actorId,
    });

    if (amendment.isDue()) {
      const usage = await this.applier.apply(amendment, contract, {
        appliedBy: 'operator',
      });

      return toAmendmentView(amendment, usage);
    }

    return this.schedule(amendment, contract.organizationId);
  }

  /**
   * O aditivo datado para o futuro: gravado pendente, com o retrato de hoje.
   *
   * O retrato é o que dá ao operador a conversa que ele precisa ter agora — "o
   * cliente está em 252 assentos e o aditivo pede 150 em janeiro". Recusar
   * seria pior: a redução é assinada com meses de antecedência justamente
   * porque a queda de uso ainda vai acontecer.
   */
  private async schedule(
    amendment: ContractAmendment,
    organizationId: string,
  ): Promise<AmendmentView> {
    const usage = await this.usage.forChanges(
      organizationId,
      amendment.changes,
    );

    await this.amendments.save(amendment);

    await this.auditLog.record({
      event: 'contract.amendment_scheduled',
      entityType: 'contract_amendment',
      entityId: amendment.id,
      organizationId,
      actorId: amendment.createdBy,
      metadata: {
        contractId: amendment.contractId,
        number: amendment.number,
        effectiveAt: amendment.effectiveAt.toISOString(),
        changes: amendment.changes,
        usage,
        exceeds: ContractUsageService.exceeded(usage),
      },
    });

    return toAmendmentView(amendment, usage);
  }

  async list(contractId: string, actorId: string): Promise<AmendmentView[]> {
    await this.platformRole.assertPermission(actorId, 'orgs:read');

    // Lambda explícita: `.map(toAmendmentView)` passaria o índice como o
    // segundo parâmetro, e o histórico sairia com um retrato de uso inventado.
    return (await this.amendments.listByContractId(contractId)).map(
      (amendment) => toAmendmentView(amendment),
    );
  }

  private async load(id: string): Promise<EnterpriseContract> {
    const contract = await this.contracts.findById(id);

    if (!contract) {
      throw new NotFoundException({
        code: 'CONTRACT_NOT_FOUND',
        message: 'Contract not found',
      });
    }

    return contract;
  }
}
