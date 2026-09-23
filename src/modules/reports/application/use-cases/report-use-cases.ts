import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OwnerScopeResolverService } from 'src/modules/integrations/application/services/owner-scope-resolver.service';
import { PlanEntitlementService } from 'src/modules/plans/application/plan-entitlement.service';
import { planLimitRefusal } from 'src/modules/plans/application/plan-limit-refusal';
import { EmailSenderPortInterface } from 'src/shared/application/ports/email-sender.port';
import { EmailTemplateRendererPortInterface } from 'src/shared/application/ports/email-template-renderer.port';
import { StoragePortInterface } from 'src/shared/application/ports/storage.port';
import { AppUrlService } from 'src/shared/infrastructure/config/app-url.service';
import { ReportDownloadTokenService } from '../services/report-download-token.service';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';
import { ReportsRepositoryInterface } from 'src/modules/reports/domain/ports/reports.repository';
import { ReportsDispatcher } from 'src/modules/reports/infrastructure/queues/reports.dispatcher';
import {
  MAX_PERIOD_DAYS,
  MIN_PERIOD_DAYS,
  PERIOD_OPTIONS_DAYS,
  REPORT_TEMPLATES,
  ReportBuilderService,
  isPeriodScoped,
} from '../services/report-builder.service';

/**
 * O catálogo, com os períodos que **esta** organização pode pedir.
 *
 * `periodOptions` só existe no modelo de período, e sai filtrado pelo piso de
 * histórico do plano: oferecer 12 meses a quem lê 3 seria vender na tela o que
 * a leitura trunca depois, e o usuário descobriria no PDF. Os demais modelos
 * não trazem o campo — a janela deles não é escolha de quem gera.
 */
@Injectable()
export class ListReportTemplatesUseCase {
  constructor(
    private readonly scope: OwnerScopeResolverService,
    private readonly planEntitlement: PlanEntitlementService,
  ) {}

  async execute(accountId: string) {
    const owner = await this.scope.resolveForAccount(accountId);
    const options = owner.organizationId
      ? await this.periodOptionsFor(owner.organizationId)
      : [...PERIOD_OPTIONS_DAYS];

    return REPORT_TEMPLATES.map((template) =>
      isPeriodScoped(template.key)
        ? { ...template, periodOptions: options }
        : { ...template },
    );
  }

  private async periodOptionsFor(organizationId: string): Promise<number[]> {
    const floor = await this.planEntitlement.historyFloorFor(organizationId);
    if (!floor) return [...PERIOD_OPTIONS_DAYS];

    const readableDays = Math.floor(
      (Date.now() - floor.getTime()) / (24 * 60 * 60 * 1000),
    );

    const allowed = PERIOD_OPTIONS_DAYS.filter((days) => days <= readableDays);

    // Piso do plano menor que a menor opção: em vez de devolver lista vazia -
    // que esconderia o seletor e faria o modelo parecer sem período -, oferece
    // o único intervalo que cabe inteiro no histórico legível.
    return allowed.length > 0
      ? [...allowed]
      : [Math.max(MIN_PERIOD_DAYS, readableDays)];
  }
}

@Injectable()
export class GenerateReportUseCase {
  constructor(
    private readonly repo: ReportsRepositoryInterface,
    private readonly dispatcher: ReportsDispatcher,
    private readonly builder: ReportBuilderService,
    private readonly scope: OwnerScopeResolverService,
    private readonly planEntitlement: PlanEntitlementService,
  ) {}

  async execute(
    accountId: string,
    templateKey: string,
    params?: Record<string, unknown>,
  ) {
    if (!this.builder.isValidTemplate(templateKey)) {
      throw new BadRequestException({
        code: 'INVALID_REPORT_TEMPLATE',
        message: `Unknown template "${templateKey}"`,
      });
    }

    /**
     * **A janela não é parâmetro de geração** — e recusar é melhor que ignorar.
     *
     * Ela é a `scoringWindowDays` da organização, a mesma com que os números do
     * relatório foram materializados (veja `ReportBuilderService.build`).
     * Aceitar o campo e descartá-lo em silêncio deixaria um cliente antigo —
     * uma aba aberta desde antes desta mudança — convencido de que escolheu 30
     * dias, e o PDF sairia declarando 14 sem que ninguém tivesse pedido isso. O
     * `remediation` diz onde a janela se altera de verdade.
     */
    if (params && 'windowDays' in params) {
      throw new DomainError({
        code: 'REPORT_WINDOW_NOT_CONFIGURABLE',
        category: 'VALIDATION',
        message:
          'A janela do relatório não é escolhida por geração: ela é a janela de análise da organização.',
        remediation:
          'Altere a janela em Organização → janela de análise e gere o relatório de novo.',
      });
    }

    /**
     * `periodDays` **só** no modelo de período, e validado aqui.
     *
     * Aqui e não no builder porque o builder roda na fila: um número fora de
     * faixa viraria um relatório `FAILED` alguns segundos depois do clique, com
     * a mensagem de erro escondida numa linha da lista. Recusado na geração, o
     * erro chega onde o pedido foi feito.
     */
    if (params && 'periodDays' in params) {
      if (!isPeriodScoped(templateKey)) {
        throw new DomainError({
          code: 'REPORT_PERIOD_NOT_SUPPORTED',
          category: 'VALIDATION',
          message: `O modelo "${templateKey}" não tem período escolhível: ele relata a janela de análise da organização.`,
          remediation:
            'Gere sem `periodDays`, ou use o modelo "Desempenho por período".',
        });
      }

      const periodDays = Number(params.periodDays);
      if (
        !Number.isFinite(periodDays) ||
        periodDays < MIN_PERIOD_DAYS ||
        periodDays > MAX_PERIOD_DAYS
      ) {
        throw new DomainError({
          code: 'REPORT_PERIOD_OUT_OF_RANGE',
          category: 'VALIDATION',
          message: `O período deve estar entre ${MIN_PERIOD_DAYS} e ${MAX_PERIOD_DAYS} dias.`,
          remediation: `Escolha um período entre ${MIN_PERIOD_DAYS} e ${MAX_PERIOD_DAYS} dias.`,
        });
      }
    }
    const owner = await this.scope.resolveForAccount(accountId);

    /**
     * O plano libera um **subconjunto** de modelos, não uma quantidade.
     *
     * Um teto numérico ("1 modelo") deixaria em aberto qual — e a resposta
     * mudaria conforme a ordem em que os modelos são listados. A lista
     * explícita no catálogo é o que faz "o Individual tem o semanal" ser uma
     * afirmação, e não um efeito colateral de ordenação.
     *
     * Modelo desconhecido é recusado acima, antes disto: "não existe" e "seu
     * plano não inclui" são respostas diferentes, e trocar uma pela outra faria
     * um erro de digitação virar oferta de upgrade.
     */
    if (owner.organizationId) {
      const state = await this.planEntitlement.itemStateFor({
        organizationId: owner.organizationId,
        feature: 'pdf-reports',
        item: templateKey,
      });

      if (!state.allowed) throw planLimitRefusal(state);
    }
    const report = await this.repo.create({
      accountId: owner.accountId,
      organizationId: owner.organizationId,
      templateKey,
      params: params ?? null,
    });
    await this.dispatcher.enqueue({ reportId: report.id });
    return report;
  }
}

@Injectable()
export class ListReportsUseCase {
  constructor(
    private readonly repo: ReportsRepositoryInterface,
    private readonly scope: OwnerScopeResolverService,
  ) {}

  async execute(accountId: string) {
    const owner = await this.scope.resolveForAccount(accountId);
    return this.repo.list(owner);
  }
}

@Injectable()
export class GetReportDownloadUseCase {
  constructor(
    private readonly repo: ReportsRepositoryInterface,
    private readonly scope: OwnerScopeResolverService,
  ) {}

  async execute(accountId: string, id: string) {
    const owner = await this.scope.resolveForAccount(accountId);
    const report = await this.repo.findById(id, owner);
    if (!report) {
      throw new NotFoundException({
        code: 'REPORT_NOT_FOUND',
        message: 'Report not found',
      });
    }
    if (report.status !== 'READY' || !report.downloadUrl) {
      throw new BadRequestException({
        code: 'REPORT_NOT_READY',
        message: `Report is not ready (status=${report.status})`,
      });
    }
    return { downloadUrl: report.downloadUrl };
  }
}

@Injectable()
export class EmailReportUseCase {
  constructor(
    private readonly repo: ReportsRepositoryInterface,
    private readonly scope: OwnerScopeResolverService,
    @Inject(EmailSenderPortInterface)
    private readonly email: EmailSenderPortInterface,
    private readonly emailTemplates: EmailTemplateRendererPortInterface,
    private readonly tokens: ReportDownloadTokenService,
    private readonly appUrl: AppUrlService,
  ) {}

  /**
   * Para onde o botão do e-mail aponta.
   *
   * **A URL assinada do bucket não serve aqui.** Ela vence em no máximo 7 dias
   * e o e-mail vive na caixa de entrada por muito mais; um link que funciona na
   * terça e falha na quinta é pior que um link que sempre exige um clique a
   * mais. Então o e-mail aponta para uma rota desta API, que confere o token e
   * redireciona para uma URL assinada na hora.
   *
   * Sem `API_PUBLIC_URL` configurada, cai no relatório dentro do app: continua
   * funcionando, porque lá existe sessão, e é o único destino que dá para
   * montar sem saber onde a API mora. A degradação é anunciada no boot.
   */
  private async downloadLink(
    accountId: string,
    reportId: string,
  ): Promise<string> {
    const token = await this.tokens.issue(accountId, reportId);
    const direct = this.appUrl.apiPathTo(
      `api/v1/reports/${reportId}/file?token=${encodeURIComponent(token)}`,
    );

    return direct ?? this.appUrl.pathTo(`reports/${reportId}`);
  }

  async execute(accountId: string, id: string, options: { to?: string }) {
    const owner = await this.scope.resolveForAccount(accountId);
    const report = await this.repo.findById(id, owner);
    if (!report) {
      throw new NotFoundException({
        code: 'REPORT_NOT_FOUND',
        message: 'Report not found',
      });
    }
    if (report.status !== 'READY' || !report.downloadUrl) {
      throw new BadRequestException({
        code: 'REPORT_NOT_READY',
        message: `Report is not ready (status=${report.status})`,
      });
    }
    const to = options.to ?? '';
    if (!to) {
      throw new BadRequestException({
        code: 'EMAIL_TO_REQUIRED',
        message: 'Recipient email is required',
      });
    }
    // Nunca `report.downloadUrl`: é a URL crua do objeto, que num bucket privado
    // chega como 403 na caixa de entrada de quem pediu o relatório.
    const link = await this.downloadLink(accountId, id);

    // O nome do catálogo, nunca `report.templateKey`: quem recebe o e-mail lê
    // "Performance semanal", não `weekly-performance`. O `??` cobre um relatório
    // gerado por um modelo que saiu do catálogo desde então.
    const templateName =
      REPORT_TEMPLATES.find((t) => t.key === report.templateKey)?.name ??
      report.templateKey;

    const { subject, html, text } = await this.emailTemplates.render(
      'report-ready',
      { templateName, link },
    );

    await this.email.send({ to, subject, html, text });
    return this.repo.markEmailed(id);
  }
}

/**
 * O outro lado do link do e-mail: valida o token e devolve uma URL assinada
 * recém-emitida.
 *
 * Reaproveita `GetReportDownloadUseCase` de propósito — toda a autorização
 * (escopo do owner, relatório pronto) já mora lá, e duplicá-la aqui criaria uma
 * segunda regra para envelhecer em separado. O token só responde *quem* está
 * pedindo; o que essa conta pode ver continua sendo decidido no mesmo lugar.
 */
@Injectable()
export class GetReportFileUseCase {
  constructor(
    private readonly download: GetReportDownloadUseCase,
    private readonly tokens: ReportDownloadTokenService,
    @Inject(StoragePortInterface)
    private readonly storage: StoragePortInterface,
  ) {}

  async execute(reportId: string, token: string): Promise<string> {
    const accountId = await this.tokens.verify(token, reportId);
    const { downloadUrl } = await this.download.execute(accountId, reportId);

    return this.storage.getReadUrl(downloadUrl);
  }
}
