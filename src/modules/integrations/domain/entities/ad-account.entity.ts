import { randomUUID } from 'crypto';

/**
 * A conta de anúncios como a tabela de fato a guarda.
 *
 * ## O que esta entidade deixou de ter, e por quê
 *
 * Ela carregava `status`, `isActive`, `syncStatus`, `lastSyncAt`, `syncError`,
 * `metadata`, `provider`, `createdAt` e `updatedAt` — **nenhuma dessas colunas
 * existe em `ad_accounts`**. A migração destrutiva de A2-S1 reconstruiu o schema
 * e esta entidade não foi junto; os `as never` no repositório calaram o
 * TypeScript, e o resultado é que vincular, desvincular e desconectar
 * estouravam em produção com `Unknown argument`. O produto seguia funcionando
 * porque as contas nascem por **descoberta no ingest**, não por estes caminhos.
 *
 * ## Os dois estados que sobraram, e que são de verdade
 *
 * **Vínculo** é `integrationId`: nulo significa desvinculada, e é o que
 * `listSyncable` já usa para não sincronizar. Desvincular é `detachIntegration`.
 *
 * **Congelamento** é `frozenAt`: a conta continua vinculada e com todo o
 * histórico, e apenas sai de cena porque o plano encolheu. São coisas
 * diferentes — e é exatamente por serem diferentes que o upgrade consegue
 * descongelar o que o plano congelou sem reativar o que o usuário desligou.
 */
type CreateAdAccountProps = {
  integrationId: string;
  organizationId: string;
  accountId: string;
  platform: string;
  externalAccountId: string;
  name: string;
  currency: string;
  timezone: string;
};

type RestoreAdAccountProps = {
  id: string;
  integrationId: string | null;
  organizationId: string;
  accountId: string;
  platform: string;
  externalAccountId: string;
  name: string;
  currency: string;
  timezone: string;
  discoveredAt: Date;
  frozenAt: Date | null;
};

export class AdAccount {
  private _id: string;
  private _integrationId: string | null;
  private _organizationId: string;
  private _accountId: string;
  private _platform: string;
  private _externalAccountId: string;
  private _name: string;
  private _currency: string;
  private _timezone: string;
  private _discoveredAt: Date;
  private _frozenAt: Date | null;

  private constructor(props: RestoreAdAccountProps) {
    this._id = props.id;
    this._integrationId = props.integrationId;
    this._organizationId = props.organizationId;
    this._accountId = props.accountId;
    this._platform = props.platform;
    this._externalAccountId = props.externalAccountId;
    this._name = props.name;
    this._currency = props.currency;
    this._timezone = props.timezone;
    this._discoveredAt = props.discoveredAt;
    this._frozenAt = props.frozenAt;
  }

  static create(props: CreateAdAccountProps): AdAccount {
    return new AdAccount({
      id: randomUUID(),
      integrationId: props.integrationId,
      organizationId: props.organizationId,
      accountId: props.accountId,
      platform: props.platform,
      externalAccountId: props.externalAccountId,
      name: props.name,
      currency: props.currency,
      timezone: props.timezone,
      discoveredAt: new Date(),
      frozenAt: null,
    });
  }

  static restore(props: RestoreAdAccountProps): AdAccount {
    return new AdAccount(props);
  }

  /** Desvincular: a credencial some, a identidade e o histórico ficam (P10). */
  detachIntegration(): void {
    this._integrationId = null;
  }

  attachIntegration(integrationId: string): void {
    this._integrationId = integrationId;
  }

  /**
   * Agenda ou aplica o congelamento.
   *
   * `at` no futuro é agendamento — o downgrade só vale no fim do período pago, e
   * congelar antes tiraria do cliente o que ele já comprou.
   */
  freezeAt(at: Date): void {
    this._frozenAt = at;
  }

  unfreeze(): void {
    this._frozenAt = null;
  }

  /** Congelada **agora**. Data futura é agendamento, não congelamento. */
  isFrozen(now: Date = new Date()): boolean {
    return this._frozenAt !== null && this._frozenAt <= now;
  }

  /** Congelamento marcado para uma data que ainda não chegou. */
  isFreezeScheduled(now: Date = new Date()): boolean {
    return this._frozenAt !== null && this._frozenAt > now;
  }

  /**
   * Conta ativa: vinculada e não congelada. É o que o teto do plano conta e o
   * que o sync sincroniza.
   */
  isActive(now: Date = new Date()): boolean {
    return this._integrationId !== null && !this.isFrozen(now);
  }

  get id() {
    return this._id;
  }

  get integrationId() {
    return this._integrationId;
  }

  get organizationId() {
    return this._organizationId;
  }

  get accountId() {
    return this._accountId;
  }

  get platform() {
    return this._platform;
  }

  get externalAccountId() {
    return this._externalAccountId;
  }

  get name() {
    return this._name;
  }

  get currency() {
    return this._currency;
  }

  get timezone() {
    return this._timezone;
  }

  get discoveredAt() {
    return this._discoveredAt;
  }

  get frozenAt() {
    return this._frozenAt;
  }

  toJSON() {
    return {
      id: this._id,
      integrationId: this._integrationId,
      organizationId: this._organizationId,
      platform: this._platform,
      externalAccountId: this._externalAccountId,
      name: this._name,
      currency: this._currency,
      timezone: this._timezone,
      discoveredAt: this._discoveredAt,
      frozenAt: this._frozenAt,
      active: this.isActive(),
    };
  }
}
