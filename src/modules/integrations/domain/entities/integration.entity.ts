import { randomUUID } from 'crypto';

export type ProviderType = 'GOOGLE' | 'META' | 'TIKTOK';

export type IntegrationStatus =
  | 'CONNECTED'
  | 'DISCONNECTED'
  | 'TOKEN_EXPIRED'
  | 'ERROR';

export type SyncStatus = 'IDLE' | 'SYNCING' | 'SUCCESS' | 'FAILED';

/**
 * Os estados em que a credencial ainda é lida pelas varreduras.
 *
 * **`ERROR` fica dentro.** É a falha transitória de renovação — timeout, 502 da
 * plataforma —, e `RefreshIntegrationTokenUseCase` a separa de `TOKEN_EXPIRED`
 * justamente para o ciclo seguinte tentar de novo. Tirá-la pararia o sync de
 * uma conta perfeitamente conectada por causa de um soluço.
 *
 * **`TOKEN_EXPIRED` e `DISCONNECTED` ficam fora.** Só uma ação do usuário —
 * reconectar — muda esses estados, e tentar de hora em hora gasta chamada de
 * plataforma sem nenhuma chance de dar certo.
 */
export const SYNCABLE_INTEGRATION_STATUSES: readonly IntegrationStatus[] = [
  'CONNECTED',
  'ERROR',
];

export function isSyncableIntegrationStatus(
  status: string | null | undefined,
): boolean {
  return SYNCABLE_INTEGRATION_STATUSES.includes(status as IntegrationStatus);
}

type CreateIntegrationProps = {
  accountId: string;
  /**
   * NOT NULL no banco desde a migração ads-first (D6): sem organização na
   * credencial, o REBIND de P10 — casar contas por
   * `(organizationId, platform, externalAccountId)` — não é implementável.
   *
   * Era opcional aqui, e o `as never` do repositório impedia o compilador de
   * apontar a divergência: uma conta sem organização produzia `organizationId:
   * null` e o INSERT falhava dentro do callback do OAuth, depois de a
   * plataforma já ter trocado o code por token. Quem provisiona a organização
   * antes de chegar aqui é `CreateIntegrationUseCase`.
   */
  organizationId: string;
  provider: string;
  providerType: ProviderType;
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  name?: string;
  metadata?: Record<string, unknown>;
};

type RestoreIntegrationProps = {
  id: string;
  accountId: string;
  organizationId: string;
  provider: string;
  providerType: ProviderType;
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  status: IntegrationStatus;
  syncStatus: SyncStatus;
  lastSyncAt?: Date | null;
  syncError?: string | null;
  disconnectedAt?: Date | null;
  metadata?: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
  name?: string;
};

export class Integration {
  private _id: string;
  private _accountId: string;
  private _organizationId: string;
  private _provider: string;
  private _providerType: ProviderType;
  private _accessToken: string;
  private _refreshToken?: string;
  private _expiresAt: Date;
  private _status: IntegrationStatus;
  private _syncStatus: SyncStatus;
  private _lastSyncAt?: Date | null;
  private _syncError?: string | null;
  private _disconnectedAt?: Date | null;
  private _metadata?: Record<string, unknown> | null;
  private _createdAt: Date;
  private _updatedAt: Date;
  private _name?: string;

  private constructor(props: RestoreIntegrationProps) {
    this._id = props.id;
    this._accountId = props.accountId;
    this._organizationId = props.organizationId;
    this._provider = props.provider;
    this._providerType = props.providerType;
    this._accessToken = props.accessToken;
    this._refreshToken = props.refreshToken;
    this._expiresAt = props.expiresAt;
    this._status = props.status;
    this._syncStatus = props.syncStatus;
    this._lastSyncAt = props.lastSyncAt ?? null;
    this._syncError = props.syncError ?? null;
    this._disconnectedAt = props.disconnectedAt ?? null;
    this._metadata = props.metadata ?? null;
    this._createdAt = props.createdAt;
    this._updatedAt = props.updatedAt;
    this._name = props.name;
  }

  static create(props: CreateIntegrationProps): Integration {
    const now = new Date();
    return new Integration({
      id: randomUUID(),
      accountId: props.accountId,
      organizationId: props.organizationId,
      provider: props.provider,
      providerType: props.providerType,
      accessToken: props.accessToken,
      refreshToken: props.refreshToken,
      expiresAt: props.expiresAt,
      status: 'CONNECTED',
      syncStatus: 'IDLE',
      lastSyncAt: null,
      syncError: null,
      disconnectedAt: null,
      metadata: props.metadata ?? null,
      name: props.name,
      createdAt: now,
      updatedAt: now,
    });
  }

  static restore(props: RestoreIntegrationProps): Integration {
    return new Integration(props);
  }

  get id() {
    return this._id;
  }
  get accountId() {
    return this._accountId;
  }
  get organizationId() {
    return this._organizationId;
  }
  get provider() {
    return this._provider;
  }
  get providerType() {
    return this._providerType;
  }
  get accessToken() {
    return this._accessToken;
  }
  get refreshToken() {
    return this._refreshToken;
  }
  get expiresAt() {
    return this._expiresAt;
  }
  get status() {
    return this._status;
  }
  get syncStatus() {
    return this._syncStatus;
  }
  get lastSyncAt() {
    return this._lastSyncAt;
  }
  get syncError() {
    return this._syncError;
  }
  get disconnectedAt() {
    return this._disconnectedAt;
  }
  get metadata() {
    return this._metadata;
  }
  get createdAt() {
    return this._createdAt;
  }
  get updatedAt() {
    return this._updatedAt;
  }
  get name() {
    return this._name;
  }

  isConnected(): boolean {
    return this._status === 'CONNECTED';
  }

  isExpiringWithin(days: number): boolean {
    const threshold = Date.now() + days * 24 * 60 * 60 * 1000;
    return this._expiresAt.getTime() <= threshold;
  }

  updateTokens(props: {
    accessToken: string;
    refreshToken?: string;
    expiresAt: Date;
  }): void {
    this._accessToken = props.accessToken;
    if (props.refreshToken !== undefined) {
      this._refreshToken = props.refreshToken;
    }
    this._expiresAt = props.expiresAt;
    this._status = 'CONNECTED';
    this._syncError = null;
    this._disconnectedAt = null;
    this._updatedAt = new Date();
  }

  markDisconnected(): void {
    this._status = 'DISCONNECTED';
    this._disconnectedAt = new Date();
    this._syncStatus = 'IDLE';
    this._updatedAt = new Date();
  }

  /**
   * Credencial vencida — o estado que diz ao usuário **reconecte**.
   *
   * Aceita a razão porque antes o chamador precisava de duas chamadas para
   * registrar status e diagnóstico, e a segunda (`markError`) sobrescrevia a
   * primeira: `TOKEN_EXPIRED` nunca chegava ao banco e a integração morria como
   * erro genérico, sem caminho de volta na tela.
   */
  markTokenExpired(reason?: string): void {
    this._status = 'TOKEN_EXPIRED';
    if (reason !== undefined) this._syncError = reason;
    this._updatedAt = new Date();
  }

  /**
   * Falha genérica.
   *
   * **Não rebaixa um estado mais específico.** `TOKEN_EXPIRED` é uma espécie de
   * erro, e mais informativa que `ERROR`: sobrescrevê-la troca "reconecte sua
   * conta" por "algo deu errado". A razão é registrada de qualquer forma, então
   * nenhum diagnóstico se perde.
   */
  markError(reason: string): void {
    this._syncError = reason;
    if (this._status !== 'TOKEN_EXPIRED') {
      this._status = 'ERROR';
    }
    this._updatedAt = new Date();
  }

  markSyncStarted(): void {
    this._syncStatus = 'SYNCING';
    this._syncError = null;
    this._updatedAt = new Date();
  }

  markSyncSucceeded(at: Date = new Date()): void {
    this._syncStatus = 'SUCCESS';
    this._lastSyncAt = at;
    this._syncError = null;
    this._updatedAt = new Date();
  }

  markSyncFailed(reason: string): void {
    this._syncStatus = 'FAILED';
    this._syncError = reason;
    this._updatedAt = new Date();
  }

  /**
   * Safe JSON projection — never includes accessToken, refreshToken or other secrets.
   */
  toJSON() {
    return {
      id: this._id,
      accountId: this._accountId,
      organizationId: this._organizationId,
      name: this._name,
      provider: this._provider,
      providerType: this._providerType,
      status: this._status,
      syncStatus: this._syncStatus,
      lastSyncAt: this._lastSyncAt,
      syncError: this._syncError,
      expiresAt: this._expiresAt,
      disconnectedAt: this._disconnectedAt,
      createdAt: this._createdAt,
      updatedAt: this._updatedAt,
    };
  }
}
