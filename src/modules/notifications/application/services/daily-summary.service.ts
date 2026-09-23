import { Injectable, Logger } from '@nestjs/common';
import { EmailSenderPortInterface } from 'src/shared/application/ports';
import {
  dailySummaryTemplate,
  dailySummaryTemplateText,
} from 'src/shared/infrastructure/email/templates';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { isEmailCategoryAllowed } from 'src/modules/preferences/domain/email-category-policy';
import { AppUrlService } from 'src/shared/infrastructure/config/app-url.service';
import { OwnerScopeResolverService } from 'src/modules/integrations/application/services/owner-scope-resolver.service';
import { PlanEntitlementService } from 'src/modules/plans/application/plan-entitlement.service';
import { OrganizationSweepPolicyService } from 'src/modules/subscriptions/access/application/organization-sweep-policy.service';
import type { SweepMode } from 'src/modules/subscriptions/access/domain/sweep-mode';
import { shouldSendSummaryToday } from 'src/modules/notifications/domain/summary-cadence';
import { SCHEDULER_TIMEZONE } from 'src/shared/infrastructure/scheduling/scheduler-timezone';
import { formatMoneyAmount } from 'src/shared/domain/formatters';

function formatDate(date: Date): string {
  return date.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });
}

type Recipient = {
  id: string;
  name: string;
  email: string;
  /** `null` quando o escopo não resolveu — a conta não passa pela pergunta. */
  organizationId: string | null;
};

@Injectable()
export class DailySummaryService {
  private readonly logger = new Logger(DailySummaryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailSender: EmailSenderPortInterface,
    private readonly appUrl: AppUrlService,
    private readonly scope: OwnerScopeResolverService,
    private readonly plans: PlanEntitlementService,
    private readonly sweep: OrganizationSweepPolicyService,
  ) {}

  async sendForAll(): Promise<{
    sent: number;
    skipped: number;
    errors: number;
  }> {
    // Pre-filter in SQL for efficiency; isEmailCategoryAllowed below stays the
    // authority on whether the mail may actually go out.
    const preferences = await this.prisma.preference.findMany({
      where: { dailyResume: true, notificationByEmail: true },
      include: { account: { select: { id: true, name: true, email: true } } },
    });

    let sent = 0;
    let skipped = 0;
    let errors = 0;
    let closedAccess = 0;

    // Um instante só para a execução inteira: com `new Date()` por conta, uma
    // execução que atravessasse a meia-noite de domingo enviaria para parte da
    // base e não para a outra.
    const now = new Date();
    const recipients: Recipient[] = [];

    for (const pref of preferences) {
      const account = pref.account;
      if (!account?.email) {
        skipped += 1;
        continue;
      }

      if (!isEmailCategoryAllowed(pref, 'DAILY_SUMMARY')) {
        skipped += 1;
        continue;
      }

      recipients.push({
        id: account.id,
        name: account.name,
        email: account.email,
        organizationId: await this.organizationOf(account.id),
      });
    }

    const modes = await this.accessModes(recipients, now);

    for (const recipient of recipients) {
      /**
       * Sem acesso aberto, o resumo não sai.
       *
       * Ele descreve desperdício e recomendações — análise —, e a análise já
       * não roda para organização sem acesso. Mandá-lo seria apontar para uma
       * tela que o cliente não consegue abrir, com números que pararam de ser
       * atualizados. É a mesma regra dos jobs, e a janela de 48h de sync diário
       * também não conta: ela traz o número, não a leitura dele.
       */
      const mode = recipient.organizationId
        ? modes.get(recipient.organizationId)
        : undefined;

      if (mode !== undefined && mode !== 'FULL') {
        skipped += 1;
        closedAccess += 1;
        continue;
      }

      if (!(await this.dueToday(recipient.organizationId, now))) {
        skipped += 1;
        continue;
      }

      try {
        await this.sendForAccount(
          recipient.id,
          recipient.name,
          recipient.email,
        );
        sent += 1;
      } catch (error) {
        this.logger.error(
          `Daily summary failed for account=${recipient.id}: ${(error as Error).message}`,
        );
        errors += 1;
      }
    }

    this.logger.log(
      `Daily summary run: sent=${sent} skipped=${skipped} errors=${errors} ` +
        `closedAccess=${closedAccess}`,
    );
    return { sent, skipped, errors };
  }

  /**
   * Qual organização é esta conta?
   *
   * O plano e o acesso são da **organização**, e o resumo é por conta — então
   * a ponte é `OwnerScopeResolverService`, a mesma que o restante do produto
   * usa para responder a pergunta. Uma consulta própria aqui responderia
   * diferente no dia em que alguém pertencesse a duas.
   */
  private async organizationOf(accountId: string): Promise<string | null> {
    try {
      const owner = await this.scope.resolveForAccount(accountId);
      return owner.organizationId ?? null;
    } catch (error) {
      this.logger.warn(
        `Daily summary scope unresolved for account=${accountId}: ` +
          `${(error as Error).message}`,
      );
      return null;
    }
  }

  /**
   * O modo de varredura de cada organização, numa consulta só.
   *
   * **Nunca bloqueia por falha**, pela mesma razão da cadência: o resumo é
   * serviço já contratado, e silenciá-lo porque a consulta de acesso caiu seria
   * punir o cliente por um defeito nosso. Mapa vazio é "não sabemos", e quem
   * não sabemos recebe.
   */
  private async accessModes(
    recipients: Recipient[],
    now: Date,
  ): Promise<Map<string, SweepMode>> {
    const organizationIds = recipients
      .map((recipient) => recipient.organizationId)
      .filter((id): id is string => id !== null);

    try {
      return await this.sweep.modesFor(organizationIds, now);
    } catch (error) {
      this.logger.warn(
        `Daily summary access unresolved: ${(error as Error).message}`,
      );
      return new Map();
    }
  }

  /**
   * O plano desta organização manda enviar hoje?
   *
   * **Nunca bloqueia por falha.** Conta sem organização resolvível continua
   * recebendo: o resumo é serviço já contratado, e silenciá-lo por um scope que
   * não resolveu seria punir o cliente por um defeito nosso.
   */
  private async dueToday(
    organizationId: string | null,
    now: Date,
  ): Promise<boolean> {
    if (!organizationId) return true;

    try {
      const cadence = await this.plans.summaryCadenceFor(organizationId);

      return shouldSendSummaryToday({
        cadence,
        now,
        timeZone: SCHEDULER_TIMEZONE,
      });
    } catch (error) {
      this.logger.warn(
        `Daily summary cadence unresolved for organization=${organizationId}: ` +
          `${(error as Error).message}`,
      );
      return true;
    }
  }

  private async sendForAccount(
    accountId: string,
    name: string,
    email: string,
  ): Promise<void> {
    const since = new Date();
    since.setHours(0, 0, 0, 0);

    const [wasteItems, recommendations] = await Promise.all([
      this.prisma.wasteItem.findMany({
        // `findingKind: WASTE` porque oportunidade é dinheiro que deixou de ser
        // ganho, não gasto mal: somá-las no mesmo resumo é o que a view
        // `open_waste` existe para impedir (§10.2).
        where: { accountId, status: 'OPEN', findingKind: 'WASTE' },
        orderBy: [{ priority: 'asc' }, { incurredAmountBase: 'desc' }],
        take: 5,
      }),
      this.prisma.recommendation.count({
        where: { accountId, status: 'NEW', evidenceAsOf: { gte: since } },
      }),
    ]);

    const wasteCount = wasteItems.length;
    const criticalCount = wasteItems.filter(
      (w) => w.priority === 'CRITICAL',
    ).length;
    const totalAmount = wasteItems.reduce(
      (sum, w) => sum + Number(w.incurredAmountBase),
      0,
    );

    if (wasteCount === 0 && recommendations === 0) {
      this.logger.log(
        `Daily summary skipped for account=${accountId} — nothing to report`,
      );
      return;
    }

    // Moeda-base da organização, não um `BRL` fixo: `formatCurrency` presa em
    // BRL mostrava "R$" para uma conta cuja moeda-base é USD ou EUR.
    const baseCurrency = wasteItems[0]?.baseCurrency ?? null;

    const topWasteItems = wasteItems.slice(0, 3).map((w) => ({
      type: w.type,
      diagnosis: w.diagnosis,
      amountFormatted: formatMoneyAmount(
        Number(w.incurredAmountBase),
        w.baseCurrency,
      ),
      priority: w.priority,
    }));

    const templateProps = {
      name,
      date: formatDate(new Date()),
      wasteCount,
      wasteAmountFormatted:
        totalAmount > 0 ? formatMoneyAmount(totalAmount, baseCurrency) : '',
      criticalCount,
      newRecommendations: recommendations,
      topWasteItems,
      appUrl: this.appUrl.baseUrl,
    };

    await this.emailSender.send({
      to: email,
      subject: `Allva — Resumo do dia ${formatDate(new Date())}`,
      html: dailySummaryTemplate(templateProps),
      text: dailySummaryTemplateText(templateProps),
    });

    this.logger.log(`Daily summary sent to account=${accountId}`);
  }
}
