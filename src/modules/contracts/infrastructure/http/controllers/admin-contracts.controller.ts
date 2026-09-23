import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Account } from 'src/modules/accounts/domain/entities';
import { CurrentUser } from 'src/modules/auth/infrastructure/http/decorators/current-user.decorator';
import {
  AmendmentOutputDto,
  ContractOutputDto,
  ContractsWithoutAiBudgetOutputDto,
  CorrectContractInputDto,
  CreateAmendmentInputDto,
  CreateContractInputDto,
  RenewContractInputDto,
  ListContractsOutputDto,
  ListContractsQueryDto,
  SuspendContractInputDto,
} from '../../../application/dtos';
import {
  AttachSignedDocumentUseCase,
  MAX_SIGNED_DOCUMENT_BYTES,
} from '../../../application/use-cases/attach-signed-document.usecase';
import { ActivateContractUseCase } from '../../../application/use-cases/activate-contract.usecase';
import { AmendContractUseCase } from '../../../application/use-cases/amend-contract.usecase';
import { IssueContractInvoiceUseCase } from '../../../application/use-cases/issue-contract-invoice.usecase';
import { RenewContractUseCase } from '../../../application/use-cases/renew-contract.usecase';
import { CorrectContractUseCase } from '../../../application/use-cases/correct-contract.usecase';
import { ManageContractUseCase } from '../../../application/use-cases/manage-contract.usecase';

/**
 * A carteira de contratos Enterprise, para quem opera a plataforma.
 *
 * Sob `/admin` pelo mesmo motivo de `OrganizationQuotasController` e do
 * pipeline comercial: o público aqui não é o dono de uma organização, é quem
 * fecha contrato. Misturá-las com as rotas de produto obrigaria as guardas de
 * organização a abrir exceção para operador, que é como um bypass nasce.
 *
 * Deliberadamente **sem** `EntitlementGuard`: um operador mexe no contrato
 * justamente quando a conta está fechada — é o momento em que o cliente ligou
 * reclamando.
 *
 * A autorização mora nos casos de uso, e não aqui. O controller é uma porta;
 * uma segunda porta para a mesma operação não deve poder esquecer a guarda.
 */
@ApiTags('Contratos Enterprise')
@ApiBearerAuth()
@Controller('/api/v1/admin/contracts')
export class AdminContractsController {
  constructor(
    private readonly manage: ManageContractUseCase,
    private readonly correction: CorrectContractUseCase,
    private readonly activateContract: ActivateContractUseCase,
    private readonly invoicing: IssueContractInvoiceUseCase,
    private readonly amendments: AmendContractUseCase,
    private readonly renewal: RenewContractUseCase,
    private readonly signedDocument: AttachSignedDocumentUseCase,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Criar contrato a partir de um lead ganho',
    description:
      'Exige a permissão de plataforma `billing:manage`. Nasce em `SIGNED` — o que vem ' +
      'antes da assinatura é o pipeline do lead. Não provisiona nada: quem ' +
      'cria a organização é a ativação.',
  })
  @ApiCreatedResponse({ type: ContractOutputDto })
  async create(
    @Body() dto: CreateContractInputDto,
    @CurrentUser() user: Account,
  ): Promise<ContractOutputDto> {
    return this.manage.create(dto, user.id);
  }

  @Get()
  @ApiOperation({ summary: 'Listar contratos' })
  @ApiOkResponse({ type: ListContractsOutputDto })
  async list(
    @Query() query: ListContractsQueryDto,
    @CurrentUser() user: Account,
  ): Promise<ListContractsOutputDto> {
    return this.manage.list(query, user.id);
  }

  /**
   * **Declarada antes de `:id`, e a ordem é obrigatória.**
   *
   * O Nest casa rotas na ordem de declaração: depois de `@Get(':id')`, este
   * caminho chegaria ao outro handler como um contrato de id
   * `without-ai-budget` e devolveria 404.
   */
  @Get('without-ai-budget')
  @ApiOperation({
    summary: 'Contratos ativos sem teto diário de gasto com IA',
    description:
      'Exige a permissão de plataforma `orgs:read`. Sem teto é escolha legítima num ' +
      'contrato ainda não precificado — o default de autoatendimento cortaria ' +
      'a entrega contratada. O que ela não pode ser é escolha por omissão, e ' +
      'esta lista é o lembrete. Não bloqueia nada: exigir o número na ativação ' +
      'travaria um contrato assinado por falta de um dado que só existe depois ' +
      'de operar (`pnpm ai:cost`).',
  })
  @ApiOkResponse({ type: ContractsWithoutAiBudgetOutputDto })
  async listWithoutAiBudget(
    @CurrentUser() user: Account,
  ): Promise<ContractsWithoutAiBudgetOutputDto> {
    return this.manage.listWithoutAiBudget(user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obter contrato por ID' })
  @ApiOkResponse({ type: ContractOutputDto })
  async getById(
    @Param('id') id: string,
    @CurrentUser() user: Account,
  ): Promise<ContractOutputDto> {
    return this.manage.get(id, user.id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Corrigir o contrato antes da ativação',
    description:
      'Só em `SIGNED`. Depois de ativado a organização já foi provisionada e ' +
      'mudança vira aditivo, que registra o acordado e o que havia antes. ' +
      'Número, lead e plano não se corrigem: mudar o plano é vender outra ' +
      'coisa, e o certo é um contrato novo.',
  })
  @ApiOkResponse({ type: ContractOutputDto })
  async correct(
    @Param('id') id: string,
    @Body() dto: CorrectContractInputDto,
    @CurrentUser() user: Account,
  ): Promise<ContractOutputDto> {
    return this.correction.execute(id, dto, user.id);
  }

  @Post(':id/signed-document')
  @ApiOperation({
    summary: 'Anexar o PDF assinado do contrato',
    description:
      'Exige a permissão de plataforma `billing:manage`. Só PDF, até 20 MB, no campo ' +
      '`file`. Guarda no bucket privado e grava em `signedDocumentUrl`; a ' +
      'leitura sai assinada. Antes da ativação, enviar de novo troca o ' +
      'arquivo; depois dela, só anexa se ainda não houver documento ' +
      '(`409 CONTRACT_DOCUMENT_LOCKED`).',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOkResponse({ type: ContractOutputDto })
  // O teto do multer corta o upload no meio, antes de o arquivo inteiro
  // ocupar memória; a checagem de tamanho no caso de uso é a segunda porta.
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_SIGNED_DOCUMENT_BYTES },
    }),
  )
  async attachSignedDocument(
    @Param('id') id: string,
    @CurrentUser() user: Account,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<ContractOutputDto> {
    return this.signedDocument.execute(id, file, user.id);
  }

  @Post(':id/activate')
  @ApiOperation({
    summary: 'Ativar o contrato e provisionar o cliente',
    description:
      'Cria organização, titular, participação, configuração de ads, ' +
      'assinatura e cotas negociadas numa transação só. Idempotente: ativar ' +
      'duas vezes devolve a mesma organização.',
  })
  @ApiOkResponse({ type: ContractOutputDto })
  async activate(@Param('id') id: string, @CurrentUser() user: Account) {
    return this.activateContract.execute(id, user.id);
  }

  @Post(':id/suspend')
  @ApiOperation({
    summary: 'Suspender o contrato',
    description:
      'O motivo decide quem pode reabrir: `NON_PAYMENT` se desfaz com a baixa ' +
      'da fatura, `OPERATOR` só por ação humana.',
  })
  @ApiOkResponse({ type: ContractOutputDto })
  async suspend(
    @Param('id') id: string,
    @Body() dto: SuspendContractInputDto,
    @CurrentUser() user: Account,
  ): Promise<ContractOutputDto> {
    return this.manage.suspend(id, dto, user.id);
  }

  @Post(':id/reactivate')
  @ApiOperation({ summary: 'Reativar o contrato suspenso' })
  @ApiOkResponse({ type: ContractOutputDto })
  async reactivate(
    @Param('id') id: string,
    @CurrentUser() user: Account,
  ): Promise<ContractOutputDto> {
    return this.manage.reactivate(id, user.id);
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: 'Cancelar o contrato' })
  @ApiOkResponse({ type: ContractOutputDto })
  async cancel(
    @Param('id') id: string,
    @CurrentUser() user: Account,
  ): Promise<ContractOutputDto> {
    return this.manage.cancel(id, user.id);
  }

  @Get(':id/invoices')
  @ApiOperation({ summary: 'Extrato do contrato' })
  async listInvoices(@Param('id') id: string, @CurrentUser() user: Account) {
    return this.invoicing.listInvoices(id, user.id);
  }

  @Post(':id/invoices')
  @ApiOperation({
    summary: 'Emitir a próxima cobrança do cronograma',
    description:
      'Anual antecipado emite uma; mensal emite a parcela seguinte a cada ' +
      'chamada. A implantação, quando há, entra na primeira. Chamar duas ' +
      'vezes emite a próxima parcela, não a mesma de novo.',
  })
  async issueInvoice(@Param('id') id: string, @CurrentUser() user: Account) {
    return this.invoicing.issueNext(id, user.id);
  }

  @Get(':id/amendments')
  @ApiOperation({ summary: 'Histórico de aditivos do contrato' })
  @ApiOkResponse({ type: [AmendmentOutputDto] })
  async listAmendments(
    @Param('id') id: string,
    @CurrentUser() user: Account,
  ): Promise<AmendmentOutputDto[]> {
    return this.amendments.list(id, user.id);
  }

  @Post(':id/amendments')
  @ApiOperation({
    summary: 'Aditar o contrato no meio da vigência',
    description:
      'Expansão, redução ou mudança de valor, com efeito datado. Data de ' +
      'hoje aplica na hora — cota e termos do contrato reescritos na mesma ' +
      'transação; data futura fica pendente até o dia. Omitir um campo é ' +
      '**mantê-lo**, e não herdar o plano.',
  })
  @ApiCreatedResponse({ type: AmendmentOutputDto })
  async amend(
    @Param('id') id: string,
    @Body() dto: CreateAmendmentInputDto,
    @CurrentUser() user: Account,
  ): Promise<AmendmentOutputDto> {
    return this.amendments.execute(
      {
        contractId: id,
        effectiveAt: new Date(dto.effectiveAt),
        reason: dto.reason,
        changes: {
          billingAmount: dto.billingAmount ?? null,
          maxSeats: dto.maxSeats ?? null,
          maxAdAccounts: dto.maxAdAccounts ?? null,
          maxMonitoredAds: dto.maxMonitoredAds ?? null,
          maxOrganizations: dto.maxOrganizations ?? null,
          llmDailyBudgetBase: dto.llmDailyBudgetBase ?? null,
        },
      },
      user.id,
    );
  }

  @Post(':id/renew')
  @ApiOperation({
    summary: 'Gerar a vigência seguinte',
    description:
      'O sucessor nasce em `SIGNED`, já ligado à mesma organização, herdando ' +
      'tudo que não foi renegociado. O contrato atual **não** é encerrado ' +
      'aqui: ele vira `RENEWED` quando a vigência dele termina, para quem ' +
      'renovou cedo não perder o acesso que ainda está pago.',
  })
  @ApiCreatedResponse({ type: ContractOutputDto })
  async renew(
    @Param('id') id: string,
    @Body() dto: RenewContractInputDto,
    @CurrentUser() user: Account,
  ): Promise<ContractOutputDto> {
    return this.renewal.execute(
      {
        contractId: id,
        startsAt: new Date(dto.startsAt),
        endsAt: new Date(dto.endsAt),
        signedAt: new Date(dto.signedAt),
        signedDocumentUrl: dto.signedDocumentUrl ?? null,
        billingAmount: dto.billingAmount,
        gracePeriodDays: dto.gracePeriodDays,
        autoRenew: dto.autoRenew,
        limits:
          dto.maxSeats === undefined &&
          dto.maxAdAccounts === undefined &&
          dto.maxMonitoredAds === undefined &&
          dto.maxOrganizations === undefined &&
          dto.llmDailyBudgetBase === undefined
            ? undefined
            : {
                maxSeats: dto.maxSeats ?? null,
                maxAdAccounts: dto.maxAdAccounts ?? null,
                maxMonitoredAds: dto.maxMonitoredAds ?? null,
                maxOrganizations: dto.maxOrganizations ?? null,
                llmDailyBudgetBase: dto.llmDailyBudgetBase ?? null,
              },
      },
      user.id,
    );
  }
}
