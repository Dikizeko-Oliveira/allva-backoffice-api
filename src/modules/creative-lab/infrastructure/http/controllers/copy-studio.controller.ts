import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Account } from 'src/modules/accounts/domain/entities';
import { CurrentUser } from 'src/modules/auth/infrastructure/http/decorators/current-user.decorator';
import { OwnerScopeResolverService } from 'src/modules/integrations/application/services/owner-scope-resolver.service';
import { RequireAccessStatuses } from 'src/modules/subscriptions/access/infrastructure/http/decorators/require-access-statuses.decorator';
import { EntitlementGuard } from 'src/modules/subscriptions/access/infrastructure/http/guards/entitlement.guard';
import { IntelligenceRoute } from 'src/shared/infrastructure/http/envelope/response-envelope.decorator';
import { ApiEnvelopeResponse } from 'src/shared/infrastructure/http/envelope/api-envelope.swagger';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';
import { GenerateCopyDto } from 'src/modules/creative-lab/application/dtos/generate-copy.dto';
import {
  CopyGenerationResultDto,
  CopyGenerationSummaryDto,
  CopyVariantSelectionDto,
} from 'src/modules/creative-lab/application/dtos/responses/copy-generation-response.dto';
import { GenerateCopyUseCase } from 'src/modules/creative-lab/application/use-cases/generate-copy.usecase';
import { CopyReadUseCases } from 'src/modules/creative-lab/application/use-cases/copy-read.usecases';

/**
 * Copy Studio — **rotas de `ads`, controller de `creative-lab`** (D3).
 *
 * O mesmo padrão de `POST /ads/{id}/analyze` e de `GET /ads/{id}/waste`: o
 * caminho HTTP pertence ao produto, o controller pertence ao dono do dado.
 *
 * **`POST` e não `GET`, mesmo quando reaproveita.** A geração cria linha em
 * `copy_generations` — é escrita de domínio. E quando reaproveita a anterior,
 * `reusedPreviousGeneration: true` diz isso na resposta, em vez de fingir que a
 * IA foi chamada.
 *
 * **Nada aqui escreve na plataforma.** A variante escolhida vira parâmetro de
 * `REPLACE_COPY` em `POST /ads/{id}/actions`, que é onde a guarda de conteúdo
 * autoral de R14 mora — confirmação do texto final por dígito, e nunca em lote.
 * Um segundo caminho de escrita aqui seria o caminho sem as guardas.
 */
@ApiTags('Creative Lab')
@ApiBearerAuth('access-token')
@Controller('/api/v1/ads')
@UseGuards(EntitlementGuard)
@RequireAccessStatuses('ALLOWED', 'GRACE_PERIOD')
@IntelligenceRoute()
export class AdCopyController {
  constructor(
    private readonly generate: GenerateCopyUseCase,
    private readonly read: CopyReadUseCases,
    private readonly scope: OwnerScopeResolverService,
  ) {}

  @Post('/:id/copy/generations')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Gerar variações de copy para este anúncio',
    description:
      'Transforma o que a análise recomendou mudar em três variações, cada ' +
      'uma testando um **ângulo** diferente. O diagnóstico que originou o ' +
      'pedido é determinístico e já existe antes desta chamada: com todos os ' +
      'provedores de IA fora do ar, a resposta vem com `aiUnavailable: true` e ' +
      'a sugestão preservada — nunca com uma variação inventada.',
  })
  @ApiEnvelopeResponse(CopyGenerationResultDto, {
    description:
      'Cada campo de texto traz o veredito da plataforma sobre si ' +
      '(`applicable`, `fitsPlatform`), porque **gerado e aplicável são coisas ' +
      'diferentes**: hoje só a Meta escreve texto, e só o texto principal e o ' +
      'CTA. Os demais campos são gerados para uso no gerenciador, e a resposta ' +
      'diz isso em vez de omiti-los.',
  })
  async generateCopy(
    @CurrentUser() user: Account,
    @Param('id') adId: string,
    @Body() body: GenerateCopyDto,
  ) {
    return this.generate.execute({
      organizationId: await this.organizationOf(user),
      accountId: user.id,
      adId,
      source: body.source,
      inputs: {
        objective: body.objective,
        tone: body.tone,
        focus: body.focus,
        extraInstructions: body.extraInstructions ?? null,
      },
      regenerate: body.regenerate ?? false,
      correlationId: null,
    });
  }

  @Get('/:id/copy/generations')
  @ApiOperation({
    summary: 'Histórico de gerações deste anúncio',
    description:
      'É o que dá sentido a salvar toda geração: a variação escolhida, quando ' +
      'foi aplicada e o que veio antes são o material da pergunta que a tabela ' +
      'existe para responder — qual sugestão de fato melhorou o desempenho.',
  })
  @ApiEnvelopeResponse(CopyGenerationSummaryDto, { isArray: true })
  async history(@CurrentUser() user: Account, @Param('id') adId: string) {
    return this.read.listForAd({
      organizationId: await this.organizationOf(user),
      adId,
    });
  }

  private async organizationOf(user: Account): Promise<string> {
    const owner = await this.scope.resolveForAccount(user.id);
    if (owner.organizationId) return owner.organizationId;

    throw new DomainError({
      code: 'ORGANIZATION_REQUIRED',
      category: 'NOT_PERMITTED',
      message: 'Selecione uma organização para gerar copy.',
      remediation: 'Envie o header X-Organization-Id de uma organização sua.',
    });
  }
}

/**
 * O que é indexado pela **geração**, e não pelo anúncio.
 *
 * Controller separado porque o prefixo é outro, e o prefixo é outro porque o
 * recurso é outro: uma geração tem id próprio e vida própria — ela sobrevive ao
 * anúncio ser arquivado, e o texto continua sendo ativo do cliente.
 */
@ApiTags('Creative Lab')
@ApiBearerAuth('access-token')
@Controller('/api/v1/copy')
@UseGuards(EntitlementGuard)
@RequireAccessStatuses('ALLOWED', 'GRACE_PERIOD')
@IntelligenceRoute()
export class CopyStudioController {
  constructor(
    private readonly read: CopyReadUseCases,
    private readonly scope: OwnerScopeResolverService,
  ) {}

  @Get('/generations/:id')
  @ApiOperation({ summary: 'Uma geração, com as variações' })
  @ApiEnvelopeResponse(CopyGenerationResultDto)
  async findOne(@CurrentUser() user: Account, @Param('id') id: string) {
    return this.read.findById({
      organizationId: await this.organizationOf(user),
      generationId: id,
    });
  }

  @Post('/variants/:id/select')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Escolher a variação',
    description:
      '**É o que destrava `REPLACE_COPY`.** A ação era declarada inviável em ' +
      '`recommendations` porque o parâmetro de texto não tinha origem; a ' +
      'variação escolhida passa a ser essa origem. A escolha é o ato explícito ' +
      'da pessoa — a geração produz três, e três textos não são um parâmetro.',
  })
  @ApiEnvelopeResponse(CopyVariantSelectionDto)
  async select(@CurrentUser() user: Account, @Param('id') id: string) {
    return this.read.select({
      organizationId: await this.organizationOf(user),
      variantId: id,
    });
  }

  private async organizationOf(user: Account): Promise<string> {
    const owner = await this.scope.resolveForAccount(user.id);
    if (owner.organizationId) return owner.organizationId;

    throw new DomainError({
      code: 'ORGANIZATION_REQUIRED',
      category: 'NOT_PERMITTED',
      message: 'Selecione uma organização para ler as gerações de copy.',
      remediation: 'Envie o header X-Organization-Id de uma organização sua.',
    });
  }
}
