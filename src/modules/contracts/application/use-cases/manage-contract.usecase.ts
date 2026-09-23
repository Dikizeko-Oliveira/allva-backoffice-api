import { Injectable, NotFoundException } from '@nestjs/common';
import { PlatformRoleService } from 'src/modules/accounts/application/services/platform-role.service';
import { SalesLeadsRepositoryInterface } from 'src/modules/sales-leads/domain/ports';
import { EnterpriseContract } from 'src/modules/contracts/domain/entities';
import { EnterpriseContractsRepositoryInterface } from 'src/modules/contracts/domain/ports/enterprise-contracts.repository';
import {
  ContractOutputDto,
  ContractsWithoutAiBudgetOutputDto,
  CreateContractInputDto,
  ListContractsOutputDto,
  ListContractsQueryDto,
  SuspendContractInputDto,
} from '../dtos';
import { toContractOutput, withLabels } from '../contract.presenter';
import { OrganizationAccessCloser } from '../services/organization-access-closer';

const DEFAULT_CURRENCY = 'BRL';
/**
 * Uma semana de tolerância, quando a negociação não disser outra coisa.
 *
 * O campo é por contrato justamente porque isso se negocia — este número só
 * responde pelo silêncio. Sete dias é o intervalo que cobre um boleto emitido
 * numa sexta e conciliado na segunda seguinte, sem esticar a inadimplência a
 * ponto de o comercial descobrir tarde demais.
 */
const DEFAULT_GRACE_PERIOD_DAYS = 7;

/**
 * A carteira de contratos, do ponto de vista do operador.
 *
 * Criar, ler, listar e mover o estado comercial. A **ativação** mora em
 * `ActivateContractUseCase`, separada porque é a única que provisiona — e o que
 * a distingue não é o verbo, é o efeito: as operações aqui mexem numa linha, e
 * ela cria uma organização inteira.
 *
 * Toda operação verifica papel de plataforma. Dentro do caso de uso, e não só
 * no controller, para que um segundo chamador — um job, o backoffice por outra
 * porta — não escape da checagem.
 */
@Injectable()
export class ManageContractUseCase {
  constructor(
    private readonly contracts: EnterpriseContractsRepositoryInterface,
    private readonly salesLeads: SalesLeadsRepositoryInterface,
    private readonly accessCloser: OrganizationAccessCloser,
    private readonly platformRole: PlatformRoleService,
  ) {}

  async create(
    input: CreateContractInputDto,
    actorId: string,
  ): Promise<ContractOutputDto> {
    await this.platformRole.assertPermission(actorId, 'billing:manage');

    const lead = await this.salesLeads.findById(input.salesLeadId);

    if (!lead) {
      /**
       * O lead não é decoração: é dele que saem razão social, titular e e-mail
       * na hora de provisionar. Aceitar um contrato sem lead alcançável seria
       * adiar a falha até a ativação, quando o cliente já está esperando.
       */
      throw new NotFoundException({
        code: 'SALES_LEAD_NOT_FOUND',
        message: 'Sales lead not found',
      });
    }

    const contract = EnterpriseContract.create({
      contractNumber: await this.contracts.nextContractNumber(
        new Date(input.startsAt).getFullYear(),
      ),
      salesLeadId: input.salesLeadId,
      planId: input.planId,
      startsAt: new Date(input.startsAt),
      endsAt: new Date(input.endsAt),
      billingInterval: input.billingInterval,
      billingAmount: input.billingAmount,
      setupFeeAmount: input.setupFeeAmount ?? null,
      currency: input.currency ?? DEFAULT_CURRENCY,
      paymentTerms: input.paymentTerms,
      paymentMethod: input.paymentMethod,
      activateOnSignature: input.activateOnSignature ?? true,
      gracePeriodDays: input.gracePeriodDays ?? DEFAULT_GRACE_PERIOD_DAYS,
      autoRenew: input.autoRenew ?? false,
      limits: {
        // `?? null` e não `?? 0`: ausência é "herda o plano", nunca "zero".
        maxSeats: input.maxSeats ?? null,
        maxAdAccounts: input.maxAdAccounts ?? null,
        maxMonitoredAds: input.maxMonitoredAds ?? null,
        maxOrganizations: input.maxOrganizations ?? null,
        llmDailyBudgetBase: input.llmDailyBudgetBase ?? null,
      },
      signedAt: new Date(input.signedAt),
      signedDocumentUrl: input.signedDocumentUrl ?? null,
    });

    await this.contracts.save(contract);

    return toContractOutput(contract);
  }

  async get(id: string, actorId: string): Promise<ContractOutputDto> {
    await this.platformRole.assertPermission(actorId, 'orgs:read');

    return (await withLabels([await this.load(id)], this.contracts))[0];
  }

  /**
   * Os contratos vivos cuja organização ainda não teve a IA precificada.
   *
   * Existe porque "sem teto" precisa ser uma decisão vista, não uma omissão. O
   * provisionamento já registra `provisioning.sem_teto_de_ia`, e log é fácil de
   * não ler — esta lista põe a mesma informação onde alguém procura.
   *
   * **Não bloqueia nada.** A alternativa era exigir o número na ativação, e ela
   * travaria um contrato assinado por falta de um dado que só existe depois de
   * uma semana de operação real.
   */
  async listWithoutAiBudget(
    actorId: string,
  ): Promise<ContractsWithoutAiBudgetOutputDto> {
    await this.platformRole.assertPermission(actorId, 'orgs:read');

    const contracts = await this.contracts.listWithoutAiBudget();

    return {
      contracts: contracts.map((contract) => ({
        ...contract,
        activatedAt: contract.activatedAt?.toISOString() ?? null,
      })),
    };
  }

  async list(
    query: ListContractsQueryDto,
    actorId: string,
  ): Promise<ListContractsOutputDto> {
    await this.platformRole.assertPermission(actorId, 'orgs:read');

    const result = await this.contracts.list({
      status: query.status,
      organizationId: query.organizationId,
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 20,
    });

    return {
      items: await withLabels(result.items, this.contracts),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    };
  }

  async suspend(
    id: string,
    input: SuspendContractInputDto,
    actorId: string,
  ): Promise<ContractOutputDto> {
    await this.platformRole.assertPermission(actorId, 'orgs:manage');

    const contract = await this.load(id);
    contract.suspend({ reason: input.reason });
    await this.contracts.update(contract);

    return toContractOutput(contract);
  }

  /**
   * Reativação **pelo operador** — a que vale para qualquer motivo.
   *
   * A que a baixa de fatura dispara é outra (`reactivateOnPayment`), e ela
   * recusa o que foi suspenso por decisão humana. Aqui é a decisão humana
   * desfazendo a si mesma.
   */
  async reactivate(id: string, actorId: string): Promise<ContractOutputDto> {
    await this.platformRole.assertPermission(actorId, 'orgs:manage');

    const contract = await this.load(id);
    contract.reactivateByOperator();
    await this.contracts.update(contract);

    return toContractOutput(contract);
  }

  /**
   * Encerra o acordo — **e fecha a porta que ele abria**.
   *
   * A assinatura da organização nasce `ACTIVE` e sem data, contando com o
   * contrato para dizer até quando vale. Cancelar só o contrato deixava essa
   * assinatura ativa e sem ninguém a limitar: o read model traz apenas
   * contratos vivos, então a organização passava a parecer self-serve e o
   * `ACTIVE` concedia acesso indefinidamente. Foi o que o roteiro ao vivo
   * pegou — cancelado devolvendo `ALLOWED`.
   *
   * Revogar é a contrapartida que o self-serve já tinha (`revokeForOwner` no
   * webhook de cancelamento), agora por organização: uma holding tem várias, e
   * encerrar um contrato não encerra os outros.
   *
   * **Condicional**, e é o que a renovação obrigou: uma organização tem mais de
   * um contrato ao mesmo tempo desde que o sucessor passou a ser assinado antes
   * de começar. Revogar sempre derrubava quem tinha acabado de renovar — o
   * cancelamento do contrato do ano passado fechava o acesso que o deste ano
   * sustenta.
   *
   * `PAYMENT_REQUIRED`, e não bloqueio: um ex-cliente Enterprise pode contratar
   * um plano self-serve, e a tela de planos é a saída honesta.
   */
  async cancel(id: string, actorId: string): Promise<ContractOutputDto> {
    await this.platformRole.assertPermission(actorId, 'orgs:manage');

    const contract = await this.load(id);
    contract.cancel();
    await this.contracts.update(contract);

    await this.accessCloser.closeIfLastContract(
      contract.organizationId,
      'CANCELED',
    );

    return toContractOutput(contract);
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
