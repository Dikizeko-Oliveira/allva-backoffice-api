import { Injectable, NotFoundException } from '@nestjs/common';
import { PlatformRoleService } from 'src/modules/accounts/application/services/platform-role.service';
import {
  EnterpriseContract,
  type NegotiatedLimits,
} from 'src/modules/contracts/domain/entities';
import { EnterpriseContractsRepositoryInterface } from 'src/modules/contracts/domain/ports/enterprise-contracts.repository';
import { ContractOutputDto, CorrectContractInputDto } from '../dtos';
import { toContractOutput } from '../contract.presenter';

/**
 * A terceira forma de mudar os termos — e a que só vale **antes** da ativação.
 *
 * As outras duas registram acordo: o aditivo altera um contrato que o cliente
 * já está usando, e a renovação abre a vigência seguinte. Esta não registra
 * nada: conserta o que foi digitado errado antes de existir organização, cota
 * ou fatura.
 *
 * Caso de uso próprio pelo mesmo motivo de `AmendContractUseCase` e
 * `RenewContractUseCase` serem separados — o que distingue os três não é o
 * campo que muda, é **quando** cada um pode ser usado, e essa é a regra que
 * cada um carrega.
 */
@Injectable()
export class CorrectContractUseCase {
  constructor(
    private readonly contracts: EnterpriseContractsRepositoryInterface,
    private readonly platformRole: PlatformRoleService,
  ) {}

  /**
   * Sem este caminho o contrato assinado com erro era um beco: `applyAmendment`
   * recusa quem não foi ativado, e a única saída era cancelar e recriar —
   * queimando um número de contrato e deixando um `CANCELED` no histórico de
   * quem nunca desistiu de nada.
   */
  async execute(
    id: string,
    input: CorrectContractInputDto,
    actorId: string,
  ): Promise<ContractOutputDto> {
    await this.platformRole.assertPermission(actorId, 'billing:manage');

    const contract = await this.load(id);

    contract.correct({
      startsAt: input.startsAt ? new Date(input.startsAt) : undefined,
      endsAt: input.endsAt ? new Date(input.endsAt) : undefined,
      billingInterval: input.billingInterval,
      billingAmount: input.billingAmount,
      setupFeeAmount: input.setupFeeAmount,
      currency: input.currency,
      paymentTerms: input.paymentTerms,
      paymentMethod: input.paymentMethod,
      activateOnSignature: input.activateOnSignature,
      gracePeriodDays: input.gracePeriodDays,
      autoRenew: input.autoRenew,
      limits: this.resolveLimits(contract, input),
      signedAt: input.signedAt ? new Date(input.signedAt) : undefined,
      signedDocumentUrl: input.signedDocumentUrl,
    });

    await this.contracts.update(contract);

    return toContractOutput(contract);
  }

  /**
   * Informar **qualquer** teto substitui o conjunto; omitir todos mantém o que
   * está lá. Mesclar campo a campo tornaria impossível voltar um teto para
   * nulo — que é o valor que diz "herda o plano".
   */
  private resolveLimits(
    contract: EnterpriseContract,
    input: CorrectContractInputDto,
  ): NegotiatedLimits | undefined {
    const touched =
      input.maxSeats !== undefined ||
      input.maxAdAccounts !== undefined ||
      input.maxMonitoredAds !== undefined ||
      input.maxOrganizations !== undefined ||
      input.llmDailyBudgetBase !== undefined;

    if (!touched) return undefined;

    return {
      maxSeats: input.maxSeats ?? null,
      maxAdAccounts: input.maxAdAccounts ?? null,
      maxMonitoredAds: input.maxMonitoredAds ?? null,
      maxOrganizations: input.maxOrganizations ?? null,
      llmDailyBudgetBase: input.llmDailyBudgetBase ?? null,
    };
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
