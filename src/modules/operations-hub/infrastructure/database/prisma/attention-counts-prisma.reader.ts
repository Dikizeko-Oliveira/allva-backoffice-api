import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import type { AttentionSignalKey } from 'src/modules/operations-hub/domain/attention-signals';
import { AttentionCountsReaderInterface } from 'src/modules/operations-hub/domain/ports';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Janela de "recente" para falhas: o que passou disto já é histórico. */
const RECENT_FAILURE_WINDOW_MS = DAY_MS;
/** Fatura recusada só incomoda enquanto a cobrança do período está viva. */
const FAILED_INVOICE_WINDOW_MS = 30 * DAY_MS;
/** Antecedência para o trial que vai vencer — dá tempo de uma conversa. */
const TRIAL_ENDING_WINDOW_MS = 7 * DAY_MS;

/** Organização excluída não pede atenção de ninguém. */
const LIVE_ORGANIZATION = { is: { deletedAt: null } } as const;

/**
 * As contagens do Operations Hub, uma consulta por sinal.
 *
 * ## Uma falha não apaga o hub
 *
 * Cada contagem roda isolada. Se uma cair, ela **some da resposta** e o resto
 * segue — o use case a devolve como `count: null`, "indisponível". O hub é a
 * porta de entrada do backoffice: se a contagem de `job_runs` falhar, o
 * administrador ainda precisa entrar para investigar, e é justamente nesse dia
 * que a tela não pode estar em branco.
 *
 * ## O que cada sinal conta
 *
 * As consultas só usam colunas indexadas em `status` (ou a chave composta de
 * `job_runs`), e nenhuma traz linha — é `count`, não `findMany`.
 */
@Injectable()
export class AttentionCountsPrismaReader implements AttentionCountsReaderInterface {
  private readonly logger = new Logger(AttentionCountsPrismaReader.name);

  constructor(private readonly prisma: PrismaService) {}

  async count(
    keys: readonly AttentionSignalKey[],
    now: Date,
  ): Promise<Partial<Record<AttentionSignalKey, number>>> {
    const settled = await Promise.allSettled(
      keys.map(async (key) => [key, await this.countOne(key, now)] as const),
    );

    const counts: Partial<Record<AttentionSignalKey, number>> = {};

    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        counts[result.value[0]] = result.value[1];
        return;
      }

      this.logger.warn(
        `Attention signal "${keys[index]}" unavailable: ${String(
          (result.reason as Error)?.message ?? result.reason,
        )}`,
      );
    });

    return counts;
  }

  private countOne(key: AttentionSignalKey, now: Date): Promise<number> {
    switch (key) {
      /**
       * Aberto e sem responsável. `IN_PROGRESS` sem responsável não entra:
       * alguém mexeu nele, e o sinal é "ninguém pegou".
       */
      case 'support.tickets_unassigned':
        return this.prisma.supportTicket.count({
          where: { status: 'OPEN', operatorId: null },
        });

      /** Prioridade alta ou crítica ainda não resolvida, com ou sem dono. */
      case 'support.tickets_high_priority_open':
        return this.prisma.supportTicket.count({
          where: {
            status: { in: ['OPEN', 'IN_PROGRESS'] },
            priority: { in: ['HIGH', 'CRITICAL'] },
          },
        });

      /** Fale-conosco que ninguém abriu. */
      case 'contacts.unread':
        return this.prisma.contact.count({ where: { status: 'NEW' } });

      /** Lead que entrou e ainda não teve primeiro contato. */
      case 'leads.awaiting_qualification':
        return this.prisma.salesLead.count({ where: { status: 'NEW' } });

      /**
       * `SIGNED`: documento assinado, organização ainda não provisionada. Só
       * sai daqui pela ativação — ato de `orgs:manage`.
       */
      case 'orgs.contracts_awaiting_activation':
        return this.prisma.enterpriseContract.count({
          where: { status: 'SIGNED' },
        });

      /**
       * `PENDING_ACTIVATION`: organização provisionada, acesso à espera da
       * primeira baixa. É cobrança, não ativação — daí `billing:read`.
       */
      case 'billing.contracts_awaiting_first_payment':
        return this.prisma.enterpriseContract.count({
          where: { status: 'PENDING_ACTIVATION' },
        });

      /** Pendente e com vencimento no passado — de assinatura ou de contrato. */
      case 'billing.invoices_overdue':
        return this.prisma.invoice.count({
          where: { status: 'PENDING', dueAt: { lt: now } },
        });

      case 'billing.invoices_failed_recent':
        return this.prisma.invoice.count({
          where: {
            status: 'FAILED',
            updatedAt: {
              gte: new Date(now.getTime() - FAILED_INVOICE_WINDOW_MS),
            },
          },
        });

      /**
       * `organization_subscriptions` é quem decide acesso
       * (`OrganizationEntitlementPrismaRepository`); a tabela `subscriptions`,
       * por conta, é o legado do checkout e não entra, sob pena de contar a
       * mesma organização duas vezes.
       */
      case 'subscriptions.past_due':
        return this.prisma.organizationSubscription.count({
          where: {
            status: { in: ['PAST_DUE', 'UNPAID'] },
            organization: LIVE_ORGANIZATION,
          },
        });

      case 'subscriptions.trials_ending_soon':
        return this.prisma.organizationSubscription.count({
          where: {
            status: 'TRIALING',
            trialEndsAt: {
              gte: now,
              lt: new Date(now.getTime() + TRIAL_ENDING_WINDOW_MS),
            },
            organization: LIVE_ORGANIZATION,
          },
        });

      /**
       * Credencial vencida ou em erro, ou conectada com a última sincronização
       * falhada. Desconectada de propósito (`DISCONNECTED`) não é problema.
       */
      case 'integrations.unhealthy':
        return this.prisma.integration.count({
          where: {
            organization: LIVE_ORGANIZATION,
            OR: [
              { status: { in: ['TOKEN_EXPIRED', 'ERROR'] } },
              { status: 'CONNECTED', syncStatus: 'FAILED' },
            ],
          },
        });

      /**
       * `RUNNING` com o lease vencido: o worker morreu segurando a janela, e
       * ninguém vai reprocessá-la até o lease ser tomado. É o "a janela que não
       * aconteceu" do mapa de endpoints.
       */
      case 'operations.job_runs_stalled':
        return this.prisma.jobRun.count({
          where: { status: 'RUNNING', leaseExpiresAt: { lt: now } },
        });

      case 'operations.job_runs_failed_recent':
        return this.prisma.jobRun.count({
          where: {
            status: 'FAILED',
            startedAt: {
              gte: new Date(now.getTime() - RECENT_FAILURE_WINDOW_MS),
            },
          },
        });
    }
  }
}
