import { randomUUID } from 'crypto';

/**
 * Canonical, append-only audit events. The matrix is intentionally a closed
 * union so that every security-relevant mutation maps to a known event name
 * and audit dashboards/alerts can rely on a stable vocabulary.
 */
export type AuditEvent =
  // --- Organization & membership ---
  | 'organization.created'
  // Quem virou dono da organização. Andou fora desta união por um acidente de
  // rota: os dois caminhos que o emitiam — provisionamento de lead e do
  // cadastro — escrevem `audit_logs` direto pela transação, sem passar pelo
  // serviço tipado, então a união nunca foi cobrada. O caminho do produto
  // (`POST /organizations`) passa por aqui e não o emitia; entrar na união é o
  // que impede a trilha de depender de por onde a organização nasceu.
  | 'owner.created'
  | 'organization.deleted'
  | 'member.invited'
  | 'member.accepted'
  | 'member.removed'
  | 'member.role.updated'
  | 'member.status.updated'
  | 'invitation.revoked'
  | 'ownership.transferred'
  // Teto de contrato alterado por um operador. É a única forma de uma
  // organização passar a valer mais do que o plano publica, e move dinheiro:
  // sem trilha, ninguém consegue dizer quem liberou 200 contas de anúncios
  // para quem, nem quando.
  | 'organization.quota.updated'
  // A janela de análise da organização. Reescreve a régua de scoring,
  // desperdício, Visão Geral e relatórios de uma vez, e o efeito só aparece no
  // ciclo seguinte — quando alguém perguntar por que o desperdício mudou de
  // patamar sem campanha nenhuma ter mudado, é aqui que está a resposta.
  | 'organization.ads_settings.updated'
  // --- Billing ---
  | 'subscription.created'
  | 'subscription.activated'
  | 'subscription.past_due'
  | 'subscription.trial_expired'
  | 'subscription.canceled'
  | 'subscription.plan_changed'
  | 'subscription.payment_method_changed'
  | 'payment.succeeded'
  | 'payment.failed'
  // Operator-driven correction of a financial record. Everything else that
  // moves an invoice is webhook-driven and already covered by `payment.*`, so
  // a row here always means a human overrode the provider.
  | 'invoice.status_changed'
  // --- Integrations (Sprint 6 / M-5) ---
  // Connecting an ad platform grants this application access to someone's ad
  // spend, and disconnecting revokes it. Both belong in the trail.
  | 'integration.connected'
  | 'integration.reconnected'
  | 'integration.disconnected'
  | 'ad_account.linked'
  | 'ad_account.unlinked'
  // --- Sincronização (A2-S3) ---
  // O vocabulário de sync entra na trilha porque as três operações abaixo
  // mudam o que o produto acredita sobre a mídia do usuário: uma ingestão
  // decide o que existe, uma quarentena decide o que ficou de fora, e um
  // rebind troca a credencial que dá acesso a tudo isso — preservando a
  // identidade do domínio (P10). Sem registro, "por que este anúncio sumiu da
  // tela?" não tem resposta reconstruível.
  | 'sync.completed'
  | 'sync.quarantined'
  | 'integration.rebound'
  // --- Escrita em plataforma (A2-S7) ---
  // Aqui a Allva deixa de observar e passa a agir sobre a mídia de alguém. O
  // pedido entra na trilha no momento em que é aceito, e não só quando a
  // plataforma responde: uma execução que trava em fila também precisa ter
  // autor, alvo e horário reconstruíveis — sobretudo ela.
  | 'ad.action.requested'
  // O desfecho, separado do pedido: entre um e outro passam minutos, uma
  // recusa da plataforma e até um kill switch. Um evento só obrigaria a
  // trilha a escolher entre registrar cedo (sem desfecho) ou tarde (perdendo
  // as que nunca terminam) — e são justamente essas que se investiga.
  | 'ad.action.executed'
  | 'ad.action.failed'
  // Consentimento e kill switch mudam **quem pode mover dinheiro**. São as duas
  // decisões que uma auditoria de incidente procura primeiro.
  | 'integration.write_consent.granted'
  | 'integration.write_consent.revoked'
  | 'organization.actions_toggled'
  // --- Aplicação de recomendação (A2-S9, §9.5 passo 9) ---
  // Distinto de `ad.action.executed`, e a distinção é o que P8 mede. A ação
  // registra que a plataforma aceitou uma escrita. Isto registra que um plano
  // que a Allva propôs foi aceito por alguém e executado inteiro. Sem a
  // segunda, "quantas das nossas recomendações foram aplicadas?" só teria
  // resposta por inferência sobre a primeira.
  | 'ad.recommendation.applied'
  // --- Account lifecycle (Sprint 6 / M-5) ---
  | 'account.created'
  | 'account.email_verified'
  | 'account.updated'
  | 'account.password_changed'
  | 'account.deleted'
  // Papel de plataforma concedido ou trocado. É a única permissão que se
  // auto-multiplica — quem concede papel concede poder de conceder —, e a
  // decisão em aberto nº 4 de `platform-rbac.md` pedia: "presuma que sim".
  | 'account.platform_role.updated'
  | 'account.platform_status.updated'
  | 'contract.amended'
  | 'contract.signed_document.attached'
  | 'contract.amendment_scheduled'
  | 'contract.renewed'
  | 'contract.expired'
  | 'contract.suspended'
  // --- Atendimento (painel de operador) ---
  // Um operador de plataforma agindo sobre o chamado de um cliente, de fora
  // da organização dele. É a mesma razão de `organization.quota.updated`
  // estar na trilha: sem registro, ninguém consegue dizer quem fechou o
  // chamado de quem, nem quando — e o cliente que reclamar terá razão sem
  // que haja como verificar.
  //
  // A **nota interna** também entra, e de propósito: ela é invisível para o
  // cliente, e justamente por isso precisa ser reconstruível. O corpo não vai
  // no metadado — a trilha registra que houve nota, não o que ela dizia.
  | 'support.ticket.assigned'
  | 'support.ticket.status_changed'
  | 'support.ticket.replied';

type CreateAuditLogProps = {
  event: AuditEvent;
  entityType?: string | null;
  entityId?: string | null;
  actorId?: string | null;
  organizationId?: string | null;
  metadata?: Record<string, unknown> | null;
};

type RestoreAuditLogProps = CreateAuditLogProps & {
  id: string;
  createdAt: Date;
};

export class AuditLog {
  private _id: string;
  private _event: AuditEvent;
  private _entityType: string | null;
  private _entityId: string | null;
  private _actorId: string | null;
  private _organizationId: string | null;
  private _metadata: Record<string, unknown> | null;
  private _createdAt: Date;

  private constructor(props: RestoreAuditLogProps) {
    this._id = props.id;
    this._event = props.event;
    this._entityType = props.entityType ?? null;
    this._entityId = props.entityId ?? null;
    this._actorId = props.actorId ?? null;
    this._organizationId = props.organizationId ?? null;
    this._metadata = props.metadata ?? null;
    this._createdAt = props.createdAt;
  }

  static create(props: CreateAuditLogProps): AuditLog {
    return new AuditLog({
      ...props,
      id: randomUUID(),
      createdAt: new Date(),
    });
  }

  static restore(props: RestoreAuditLogProps): AuditLog {
    return new AuditLog(props);
  }

  get id() {
    return this._id;
  }

  get event() {
    return this._event;
  }

  get entityType() {
    return this._entityType;
  }

  get entityId() {
    return this._entityId;
  }

  get actorId() {
    return this._actorId;
  }

  get organizationId() {
    return this._organizationId;
  }

  get metadata() {
    return this._metadata;
  }

  get createdAt() {
    return this._createdAt;
  }
}
