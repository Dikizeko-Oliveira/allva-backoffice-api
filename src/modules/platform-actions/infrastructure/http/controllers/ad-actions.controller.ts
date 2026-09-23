import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { Account } from 'src/modules/accounts/domain/entities';
import { CurrentUser } from 'src/modules/auth/infrastructure/http/decorators/current-user.decorator';
import { OwnerScopeResolverService } from 'src/modules/integrations/application/services/owner-scope-resolver.service';
import { RequirePermissions } from 'src/modules/organizations/infrastructure/http/decorators/require-permissions.decorator';
import { OrganizationAccessGuard } from 'src/modules/organizations/infrastructure/http/guards/organization-access.guard';
import { CreateAdActionBatchDto } from 'src/modules/platform-actions/application/dtos/create-ad-action-batch.dto';
import { CreateAdActionDto } from 'src/modules/platform-actions/application/dtos/create-ad-action.dto';
import { ExecuteActionUseCase } from 'src/modules/platform-actions/application/use-cases/execute-action.usecase';
import { ExecuteBatchUseCase } from 'src/modules/platform-actions/application/use-cases/execute-batch.usecase';
import { GetActionExecutionUseCase } from 'src/modules/platform-actions/application/use-cases/get-action-execution.usecase';
import { ListAvailableActionsUseCase } from 'src/modules/platform-actions/application/use-cases/list-available-actions.usecase';
import { RevertActionUseCase } from 'src/modules/platform-actions/application/use-cases/revert-action.usecase';
import { RequireAccessStatuses } from 'src/modules/subscriptions/access/infrastructure/http/decorators/require-access-statuses.decorator';
import { EntitlementGuard } from 'src/modules/subscriptions/access/infrastructure/http/guards/entitlement.guard';
import { ResponseEnvelope } from 'src/shared/infrastructure/http/envelope/response-envelope.decorator';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';
import {
  ActionAcceptedDto,
  ActionExecutionDto,
  AvailableActionsDto,
  BatchResultDto,
} from 'src/modules/platform-actions/application/dtos/responses/platform-action-response.dto';
import {
  ApiEnvelopeRawResponse,
  ApiEnvelopeResponse,
} from 'src/shared/infrastructure/http/envelope/api-envelope.swagger';
import { ApiDomainError } from 'src/shared/infrastructure/http/errors/api-error.swagger';

/**
 * `/ads/{id}/actions` — **rota de `ads`, controller de `platform-actions`** (D3).
 *
 * A mesma resolução que `GET /ads/{id}/waste` usa desde A2-S5 e
 * `GET /ads/{id}/recommendations` desde A2-S7: `ads` é a base do grafo (§5.3
 * r.1) e não pode importar quem escreve. O caminho HTTP pertence ao produto; o
 * controller pertence ao dono do dado.
 *
 * **Toda rota aqui declara permissão** (§13.5), e o harness cobra: uma rota de
 * escrita sem `@RequirePermissions` não falha em teste nenhum — o
 * `OrganizationAccessGuard` a deixa passar, porque rota sem metadado é rota que
 * optou por não ter RBAC.
 *
 * **`@ResponseEnvelope()` e não `@IntelligenceRoute()`, e a diferença não é
 * estilo.** P7 cobra `meta.provenance` de quem devolve **número derivado**, e
 * nenhuma rota daqui devolve: `available` declara capacidade, `create`, `revert`
 * e `batch` aceitam uma intenção (202), `execution` reporta o estado de uma
 * escrita. Não há janela nem versão de algoritmo a declarar sobre nada disso.
 *
 * Marcado como inteligência, o controller **inteiro** respondia `500` fora de
 * produção: o handler terminava bem e o interceptor derrubava a resposta por
 * falta de um campo que não teria o que conter. Inventar `algoVersion` para
 * calar o interceptor seria pior — diria ao cliente que houve um cálculo que
 * não houve. Uma rota futura daqui que realmente derive número carrega
 * `@IntelligenceRoute()` nela mesma: o handler vence a classe.
 */
@ApiTags('Ads')
@ApiBearerAuth('access-token')
@Controller('/api/v1/ads')
@UseGuards(EntitlementGuard, OrganizationAccessGuard)
@RequireAccessStatuses('ALLOWED', 'GRACE_PERIOD')
@ResponseEnvelope()
export class AdActionsController {
  constructor(
    private readonly listAvailable: ListAvailableActionsUseCase,
    private readonly executeAction: ExecuteActionUseCase,
    private readonly getExecution: GetActionExecutionUseCase,
    private readonly revertAction: RevertActionUseCase,
    private readonly executeBatch: ExecuteBatchUseCase,
    private readonly scope: OwnerScopeResolverService,
  ) {}

  @Get('/:id/actions/available')
  @RequirePermissions('actions:read')
  @ApiOperation({
    summary: 'Ações disponíveis para um anúncio',
    description:
      'Lista as treze ações, disponíveis ou não, cada uma com o motivo. ' +
      'Uma ação que a plataforma não suporta é declarada, nunca omitida (P6).',
  })
  @ApiEnvelopeResponse(AvailableActionsDto, {
    description:
      '**Responde mesmo com a escrita desligada**, e devolve os três portões ' +
      'separados em `writeGates`. Colapsá-los faria "esta instalação não ' +
      'escreve" e "sua organização desligou" virarem a mesma frase — e só a ' +
      'segunda tem ação do lado do usuário.',
  })
  async available(@CurrentUser() user: Account, @Param('id') id: string) {
    return this.listAvailable.execute({
      organizationId: await this.organizationOf(user),
      adId: id,
    });
  }

  /**
   * `POST /ads/{id}/actions` — **202, nunca 200** (§8.4).
   *
   * A resposta não afirma que o anúncio está pausado: afirma que a Allva aceitou
   * a intenção de pausá-lo e que a plataforma ainda não respondeu. `Location`
   * aponta para onde o cliente acompanha o desfecho. Devolver `200` com o estado
   * novo seria afirmar um efeito que ninguém observou — e a tela mostraria
   * "pausado" para um anúncio que a Meta pode recusar meio segundo depois.
   *
   * `Idempotency-Key` é **opcional no protocolo e obrigatório na prática**:
   * ausente, geramos uma, e o pedido perde a proteção contra o próprio retry.
   * Recusar sem ela quebraria todo cliente que ainda não a manda; gerá-la em
   * silêncio é a degradação honesta — o campo volta na resposta para que o
   * cliente saiba com que chave repetir.
   */
  @Post('/:id/actions')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermissions('actions:execute')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOperation({
    summary: 'Executar uma ação sobre um anúncio',
    description:
      'Responde 202 com Location. `dryRun` avalia todas as guardas e devolve ' +
      'o relatório sem escrever; sem `dryRun`, o default vem da instalação.',
  })
  @ApiEnvelopeResponse(ActionAcceptedDto, {
    status: 202,
    description:
      '**202, nunca 200.** Não afirma que o anúncio está pausado — afirma que ' +
      'a intenção foi aceita e que a plataforma ainda não respondeu. ' +
      '`Location` aponta para o acompanhamento. Uma tela que renderize ' +
      '"pausado" aqui vai mentir sempre que a plataforma recusar depois.',
  })
  @ApiEnvelopeRawResponse({
    status: 200,
    description:
      'O relatório do dry-run. **Todos** os bloqueios, não o primeiro: uma ' +
      'validação que responde um obstáculo por requisição obriga o usuário a ' +
      'descobrir os outros por tentativa.',
  })
  @ApiDomainError(403, 'Guardas de P5, e o que o plano contratado inclui.', [
    'ACTIONS_KILL_SWITCH_ON',
    'WRITE_CONSENT_REQUIRED',
    'PERMISSION_DENIED',
    /**
     * Distinto de `PERMISSION_DENIED` de propósito, mesmo com o mesmo status:
     * um manda falar com o administrador da organização e o outro manda para a
     * página de planos. Trocar um pelo outro manda cada um para o lugar onde
     * ninguém pode ajudá-lo.
     */
    'PLAN_FEATURE_NOT_INCLUDED',
  ])
  @ApiDomainError(
    409,
    'Escrita em voo no mesmo alvo (I2), ou chave reusada com payload diferente.',
    ['WRITE_IN_FLIGHT', 'IDEMPOTENCY_KEY_REUSED'],
  )
  @ApiDomainError(
    422,
    'A plataforma não suporta a ação, ou recusou o pedido.',
    ['UNSUPPORTED_BY_PLATFORM', 'PLATFORM_REJECTED'],
  )
  @ApiDomainError(
    429,
    'Teto diário ou limite de rajada da organização (C10).',
    ['ACTION_DAILY_CAP_REACHED', 'ACTION_BURST_LIMIT'],
  )
  async create(
    @CurrentUser() user: Account,
    @Param('id') id: string,
    @Body() body: CreateAdActionDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const result = await this.executeAction.execute({
      organizationId: await this.organizationOf(user),
      accountId: user.id,
      adId: id,
      body,
      idempotencyKey: idempotencyKey?.trim() || randomUUID(),
      correlationId: request.header('x-correlation-id') ?? null,
      ipAddress: request.ip ?? null,
      userAgent: request.header('user-agent') ?? null,
    });

    if (result.executionId) {
      response.setHeader(
        'Location',
        `/api/v1/ads/actions/executions/${result.executionId}`,
      );
    } else {
      // Dry-run não cria recurso, então não há para onde apontar. `200` diz
      // exatamente isso: a resposta **é** o resultado, não um recibo.
      response.status(HttpStatus.OK);
    }

    return result.body;
  }

  @Get('/actions/executions/:executionId')
  @RequirePermissions('actions:read')
  @ApiOperation({
    summary: 'Acompanhar uma execução',
    description:
      'O alvo do `Location` do 202. Expõe `observedStatus` e `desiredStatus` ' +
      'separados — é a diferença entre "pausando…" e "pausado".',
  })
  @ApiEnvelopeResponse(ActionExecutionDto)
  async execution(
    @CurrentUser() user: Account,
    @Param('executionId') executionId: string,
  ) {
    return this.getExecution.execute({
      organizationId: await this.organizationOf(user),
      executionId,
    });
  }

  /**
   * `POST /ads/actions/executions/{id}/revert` — §9.6.
   *
   * **Exige `actions:execute_sensitive`**, e não a permissão da ação original.
   * Reverter é escrever, e quem pode desfazer um ajuste de orçamento está
   * mexendo em orçamento — pedir só `actions:execute` daria a um `ANALYST` essa
   * capacidade pela porta dos fundos. Mais restritivo que o necessário para
   * pausar e reativar, e é a troca certa: reverter é sempre uma correção de algo
   * que já saiu errado uma vez.
   */
  @Post('/actions/executions/:executionId/revert')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermissions('actions:execute_sensitive')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOperation({
    summary: 'Reverter uma execução concluída',
    description:
      'Cria uma **ação nova** com origem REVERT, derivada do estado capturado ' +
      'antes da escrita original. Passa pelas mesmas guardas de P5.',
  })
  @ApiEnvelopeResponse(ActionAcceptedDto, {
    status: 202,
    description:
      'A ação inversa, não a mesma com sinal trocado: reverter um `PAUSE_AD` ' +
      'é um `ENABLE_AD`. Manter o tipo original faria a reversão ser recusada ' +
      'pela mesma validação que aprovou a ação.',
  })
  @ApiDomainError(422, 'A ação original é irreversível (`ARCHIVE_AD`).', [
    'ACTION_NOT_REVERSIBLE',
  ])
  async revert(
    @CurrentUser() user: Account,
    @Param('executionId') executionId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const result = await this.revertAction.execute({
      organizationId: await this.organizationOf(user),
      accountId: user.id,
      executionId,
      idempotencyKey: idempotencyKey?.trim() || randomUUID(),
      correlationId: request.header('x-correlation-id') ?? null,
    });

    const created = result.data as { executionId?: string };
    if (created.executionId) {
      response.setHeader(
        'Location',
        `/api/v1/ads/actions/executions/${created.executionId}`,
      );
    }

    return result;
  }

  /**
   * `POST /ads/actions/batch` — §13.5, entrega 6.
   *
   * **`actions:execute_sensitive`**, e não a permissão da ação mais fraca do
   * lote. Um lote é a ferramenta que transforma doze cliques em um; é também a
   * que transforma um engano de doze anúncios num engano de cem, e quem pode
   * disparar cem escritas de uma vez precisa ser quem já pode as sensíveis.
   *
   * Responde `200`, não `202`: o corpo **é** o relatório — cada item com o
   * desfecho dele. Um `202` prometeria que a resposta viria depois, e ela já
   * veio.
   */
  @Post('/actions/batch')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('actions:execute_sensitive')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOperation({
    summary: 'Executar uma ação sobre vários anúncios',
    description:
      'Máximo 100 itens. Cada item é revalidado individualmente e a recusa de ' +
      'um não aborta o lote. Acima de 10 itens, o dry-run exige ' +
      'validationDepth=PLATFORM.',
  })
  @ApiEnvelopeResponse(BatchResultDto, {
    description:
      '**200, não 202: o corpo é o relatório.** Uma recusa vira linha, não ' +
      'exceção que sobe — abortar devolveria ao usuário o trabalho de ' +
      'descobrir quais itens teriam passado, que é o trabalho que o lote ' +
      'existe para tirar dele.',
  })
  @ApiDomainError(403, 'O plano contratado não inclui execução em lote.', [
    'PLAN_FEATURE_NOT_INCLUDED',
  ])
  @ApiDomainError(
    422,
    'Lote acima de 100 itens, ou conteúdo autoral de IA sem confirmação (R14).',
    ['BATCH_TOO_LARGE', 'AI_CONTENT_CONFIRMATION_REQUIRED'],
  )
  async batch(
    @CurrentUser() user: Account,
    @Body() body: CreateAdActionBatchDto,
    @Req() request: Request,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.executeBatch.execute({
      organizationId: await this.organizationOf(user),
      accountId: user.id,
      body,
      idempotencyKey: idempotencyKey?.trim() || randomUUID(),
      correlationId: request.header('x-correlation-id') ?? null,
      ipAddress: request.ip ?? null,
      userAgent: request.header('user-agent') ?? null,
    });
  }

  private async organizationOf(user: Account): Promise<string> {
    const owner = await this.scope.resolveForAccount(user.id);
    if (owner.organizationId) return owner.organizationId;

    throw new DomainError({
      code: 'ORGANIZATION_REQUIRED',
      category: 'NOT_PERMITTED',
      message: 'Selecione uma organização para agir sobre anúncios.',
      remediation: 'Envie o header X-Organization-Id de uma organização sua.',
    });
  }
}
