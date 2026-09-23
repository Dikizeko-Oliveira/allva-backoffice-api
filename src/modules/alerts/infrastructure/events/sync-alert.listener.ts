import { Injectable } from '@nestjs/common';
import { DomainEvent } from 'src/shared/domain/events/domain-event';
import { jobContextFrom } from 'src/shared/domain/events/job-context';
import {
  OnDomainEvent,
  jobIdFor,
} from 'src/shared/infrastructure/events/on-domain-event.decorator';
import type { AdLifecycleStatus } from 'src/shared/domain/events/domain-event-map';
import { AlertsDispatcher } from '../queues/alerts.dispatcher';

/**
 * Os status **em minúscula**, para caberem no meio da frase do alerta.
 *
 * `ACTIVE`/`PAUSED` são a linguagem da plataforma, não a de quem lê o alerta:
 * interpolados crus, obrigavam o usuário a traduzir constante de código para
 * descobrir o que a Allva pediu e o que a plataforma fez.
 */
const STATUS_LABEL: Readonly<Record<AdLifecycleStatus, string>> = {
  ACTIVE: 'ativo',
  PAUSED: 'pausado',
  ARCHIVED: 'arquivado',
  DELETED: 'excluído',
  PENDING_REVIEW: 'em revisão',
  REJECTED: 'reprovado',
};

/**
 * A causa da divergência dita como frase, não como código.
 *
 * A causa é o que separa "alguém mexeu no seu anúncio" de "nossa escrita não foi
 * confirmada" — duas situações com donos diferentes, e `(UNVERIFIED_WRITE)` no
 * fim da frase não distinguia nenhuma delas para quem lê.
 */
const DRIFT_CAUSE_LABEL: Readonly<Record<string, string>> = {
  UNVERIFIED_WRITE: 'a plataforma não confirmou a alteração que enviamos',
  PLATFORM_REVIEW: 'a plataforma colocou o anúncio em revisão',
  PLATFORM_REJECTED: 'a plataforma reprovou o anúncio',
  OPERATOR_OR_RULE: 'alguém ou alguma regra alterou o anúncio fora da Allva',
  REMOVED_ON_PLATFORM: 'o anúncio foi removido na plataforma',
  UNKNOWN: 'não foi possível determinar a causa',
};

/**
 * `alerts` como **consumidor de evento puro** (§5.3 r.7) — a correção do alerta
 * órfão do v1.
 *
 * No v1 qualquer módulo injetava `CreateAlertUseCase` e montava o alerta como
 * queria. O worker de waste passava `referenceType: 'waste_item'` sem nunca
 * passar `referenceId`: o alerta nascia apontando para lugar nenhum, e nada no
 * banco impedia. Aqui o caminho é único — evento entra, alerta sai — e o sujeito
 * é escolhido **neste arquivo**, contra o conjunto fechado de seis FKs que o
 * `CHECK` de exclusividade cobra no banco.
 *
 * **Todo handler apenas enfileira** (⊕10). `EventEmitter2` é síncrono: persistir
 * e notificar inline poria a latência do e-mail dentro do ingest, e uma conta de
 * 5k anúncios passaria a levar o tempo do SMTP para sincronizar.
 */
@Injectable()
export class SyncAlertListener {
  constructor(private readonly dispatcher: AlertsDispatcher) {}

  /**
   * A guarda de arquivamento agiu (§8.2 passo 9).
   *
   * O sujeito é a **conta**, não um anúncio: na hora em que a guarda decide não
   * arquivar, não se sabe sequer quais anúncios teriam sido arquivados — é essa
   * a razão de `Alert` precisar de seis sujeitos e não cinco (⊕1).
   */
  @OnDomainEvent('sync.archive_suppressed')
  async onArchiveSuppressed(
    event: DomainEvent<'sync.archive_suppressed'>,
  ): Promise<void> {
    await this.dispatcher.raise(
      {
        ctx: jobContextFrom(event),
        organizationId: event.organizationId,
        type: 'AD_ARCHIVE_SUPPRESSED',
        severity: 'WARNING',
        title: 'Arquivamento suspenso nesta conta',
        message:
          'A leitura da plataforma não cobriu a conta inteira, então nenhum anúncio ' +
          `foi arquivado. Motivo: ${event.payload.reason}`,
        subject: { kind: 'AD_ACCOUNT', adAccountId: event.payload.adAccountId },
        metadata: { code: event.payload.code },
      },
      jobIdFor(event, 'archive-suppressed'),
    );
  }

  /**
   * Anúncio que a plataforma não conseguiu localizar na hierarquia.
   *
   * Também é sobre a conta: **na quarentena o anúncio sequer existe no
   * domínio**, que é justamente a razão do alerta. Um sujeito `AD` aqui seria o
   * órfão de novo, com outro nome.
   */
  @OnDomainEvent('sync.quarantined')
  async onQuarantined(event: DomainEvent<'sync.quarantined'>): Promise<void> {
    await this.dispatcher.raise(
      {
        ctx: jobContextFrom(event),
        organizationId: event.organizationId,
        type: 'SYNC_QUARANTINE',
        severity: 'WARNING',
        title: 'Anúncios em quarentena de sincronização',
        message:
          `${event.payload.externalAdId} não pôde entrar no domínio: ` +
          `${event.payload.reason}. O próximo ingest tenta de novo.`,
        subject: { kind: 'AD_ACCOUNT', adAccountId: event.payload.adAccountId },
      },
      jobIdFor(event, 'quarantine'),
    );
  }

  /** Divergência entre o que pedimos e o que a plataforma faz (§8.5a). */
  @OnDomainEvent('ad.drifted')
  async onDrifted(event: DomainEvent<'ad.drifted'>): Promise<void> {
    await this.dispatcher.raise(
      {
        ctx: jobContextFrom(event),
        organizationId: event.organizationId,
        type: 'AD_DRIFT_DETECTED',
        severity: 'WARNING',
        title: 'O anúncio não está no estado que pedimos',
        message:
          `Pedimos ${STATUS_LABEL[event.payload.expected]} e a plataforma ` +
          `reporta ${STATUS_LABEL[event.payload.observed]}: ` +
          `${DRIFT_CAUSE_LABEL[event.payload.driftCause] ?? event.payload.driftCause}.`,
        subject: { kind: 'AD', adId: event.payload.adId },
      },
      jobIdFor(event, 'drift'),
    );
  }

  /**
   * A escada de verificação esgotou sem confirmar a escrita.
   *
   * Só este resultado vira alerta: `CONFIRMED` é o caminho feliz e
   * `INCONCLUSIVE` é um degrau intermediário — alertar sobre eles ensinaria o
   * usuário a ignorar a caixa de alertas antes do primeiro caso real.
   *
   * `DIVERGED` também não alerta aqui: ele significa que a plataforma mostra
   * outro estado, e quem reporta divergência entre o que sabemos e o que a
   * plataforma faz é o drift do `sync` — que já tem alerta próprio e enxerga o
   * caso inteiro, inclusive quando a mudança veio de fora da Allva.
   */
  @OnDomainEvent('action.verified')
  async onVerified(event: DomainEvent<'action.verified'>): Promise<void> {
    if (event.payload.verificationResult !== 'UNVERIFIED_WRITE') return;

    await this.dispatcher.raise(
      {
        ctx: jobContextFrom(event),
        organizationId: event.organizationId,
        type: 'UNVERIFIED_WRITE',
        severity: 'CRITICAL',
        title: 'Não conseguimos confirmar uma alteração',
        message:
          'A escrita foi enviada mas a plataforma não confirmou o novo estado ' +
          'dentro da janela de verificação. O anúncio voltou a aceitar ações.',
        subject: { kind: 'AD', adId: event.payload.adId },
        metadata: { executionId: event.payload.executionId },
      },
      jobIdFor(event, 'unverified-write'),
    );
  }

  /** Contas que a credencial nova não alcança depois de um rebind (§8.6). */
  @OnDomainEvent('integration.rebound')
  async onRebound(event: DomainEvent<'integration.rebound'>): Promise<void> {
    if (event.payload.unreachableAdAccountIds.length === 0) return;

    for (const adAccountId of event.payload.unreachableAdAccountIds) {
      await this.dispatcher.raise(
        {
          ctx: jobContextFrom(event),
          organizationId: event.organizationId,
          type: 'INTEGRATION_DISCONNECTED',
          severity: 'CRITICAL',
          title: 'Perdemos acesso a uma conta de anúncios',
          message:
            'A nova credencial não alcança esta conta. Os anúncios continuam ' +
            'existindo e gastando — nada foi arquivado nem resolvido.',
          subject: { kind: 'AD_ACCOUNT', adAccountId },
        },
        jobIdFor(event, `rebind-unreachable:${adAccountId}`),
      );
    }
  }

  /** Credencial desconectada: as contas ficam sem observação até religar. */
  @OnDomainEvent('integration.disconnected')
  async onDisconnected(
    event: DomainEvent<'integration.disconnected'>,
  ): Promise<void> {
    await this.dispatcher.raise(
      {
        ctx: jobContextFrom(event),
        organizationId: event.organizationId,
        type: 'INTEGRATION_DISCONNECTED',
        severity: 'CRITICAL',
        title: 'Integração desconectada',
        message:
          `${event.payload.adAccountIds.length} conta(s) de anúncios ficaram sem ` +
          'credencial. A identidade e o histórico são preservados (P10).',
        subject: {
          kind: 'INTEGRATION',
          integrationId: event.payload.integrationId,
        },
      },
      jobIdFor(event, 'integration-disconnected'),
    );
  }
}
