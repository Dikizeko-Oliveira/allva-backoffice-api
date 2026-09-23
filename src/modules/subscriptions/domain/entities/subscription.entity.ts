import { randomUUID } from 'crypto';
import { Plan } from 'src/modules/plans/domain/entities';
import {
  AccessStatus,
  BillingStatus,
  mapBillingToAccess,
} from 'src/modules/subscriptions/access/domain/access-status';

type CreateSubscriptionProps = {
  accountId: string;
  planId: string;
  billingCardId?: string;
  billingStatus: BillingStatus;
  billingProvider?: 'STRIPE';
  startedAt: Date;
  expiresAt: Date;
  externalReference?: string;
};

type RestoreSubscriptionProps = {
  id: string;
  accountId: string;
  planId: string;
  billingCardId?: string;
  externalSubscriptionId?: string;
  externalReference?: string;
  authorizationUrl?: string;
  nextBillingAt?: Date;
  canceledAt?: Date;
  gracePeriodEndsAt?: Date;
  billingProvider?: 'STRIPE';
  pendingPlanId?: string;
  pendingPlanEffectiveAt?: Date;
  billingStatus: BillingStatus;
  accessStatus: AccessStatus;
  automaticRenovation: boolean;
  isAnnual: boolean;
  startedAt: Date;
  expiresAt: Date;
  createdAt: Date;
  plan?: Plan;
};

const GRACE_PERIOD_DAYS = 1;

export class Subscription {
  private _id: string;
  private _accountId: string;
  private _planId: string;
  private _billingCardId?: string;
  private _externalSubscriptionId?: string;
  private _externalReference?: string;
  private _authorizationUrl?: string;
  private _nextBillingAt?: Date;
  private _canceledAt?: Date;
  private _pendingPlanId?: string;
  private _pendingPlanEffectiveAt?: Date;
  private _gracePeriodEndsAt?: Date;
  private _billingProvider?: 'STRIPE';
  private _billingStatus: BillingStatus;
  private _accessStatus: AccessStatus;
  private _automaticRenovation: boolean;
  private _isAnnual: boolean;
  private _startedAt: Date;
  private _expiresAt: Date;
  private _createdAt: Date;
  private _plan?: Plan;

  private constructor(props: RestoreSubscriptionProps) {
    this._id = props.id;
    this._accountId = props.accountId;
    this._planId = props.planId;
    this._billingCardId = props.billingCardId;
    this._billingStatus = props.billingStatus;
    this._accessStatus = props.accessStatus;
    this._externalSubscriptionId = props.externalSubscriptionId;
    this._externalReference = props.externalReference;
    this._authorizationUrl = props.authorizationUrl;
    this._nextBillingAt = props.nextBillingAt;
    this._canceledAt = props.canceledAt;
    this._pendingPlanId = props.pendingPlanId;
    this._pendingPlanEffectiveAt = props.pendingPlanEffectiveAt;
    this._gracePeriodEndsAt = props.gracePeriodEndsAt;
    this._billingProvider = props.billingProvider;
    this._startedAt = props.startedAt;
    this._automaticRenovation = props.automaticRenovation;
    this._isAnnual = props.isAnnual;
    this._expiresAt = props.expiresAt;
    this._createdAt = props.createdAt;
    this._plan = props.plan;
  }

  static create(props: CreateSubscriptionProps): Subscription {
    const accessStatus = mapBillingToAccess(props.billingStatus);
    return new Subscription({
      id: randomUUID(),
      accountId: props.accountId,
      planId: props.planId,
      billingCardId: props.billingCardId,
      billingStatus: props.billingStatus,
      accessStatus,
      billingProvider: props.billingProvider,
      externalReference: props.externalReference,
      automaticRenovation: true,
      isAnnual: false,
      startedAt: props.startedAt,
      expiresAt: props.expiresAt,
      createdAt: new Date(),
    });
  }

  static createFree(props: {
    accountId: string;
    planId: string;
    trialDays: number;
  }): Subscription {
    const startedAt = new Date();
    const expiresAt = new Date(
      startedAt.getTime() + props.trialDays * 24 * 60 * 60 * 1000,
    );

    return Subscription.create({
      accountId: props.accountId,
      planId: props.planId,
      // TRIALING, nao ACTIVE: o plano FREE **e** o teste gratuito, e nao ha
      // camada gratuita para onde cair quando ele fecha. Gravar ACTIVE fazia a
      // base contar quem esta testando como cliente pagante. `mapBillingToAccess`
      // ja trata TRIALING como ALLOWED, entao o acesso durante a janela nao muda.
      billingStatus: 'TRIALING',
      startedAt,
      expiresAt,
    });
  }

  static createPendingPayment(props: {
    accountId: string;
    planId: string;
    billingProvider: 'STRIPE';
    billingCardId?: string;
    externalReference?: string;
  }): Subscription {
    const startedAt = new Date();

    return Subscription.create({
      accountId: props.accountId,
      planId: props.planId,
      billingCardId: props.billingCardId,
      billingStatus: 'PENDING_PAYMENT',
      billingProvider: props.billingProvider,
      externalReference: props.externalReference,
      startedAt,
      expiresAt: startedAt,
    });
  }

  static restore(props: RestoreSubscriptionProps): Subscription {
    return new Subscription(props);
  }

  attachProviderSubscription(props: {
    externalSubscriptionId: string;
    authorizationUrl?: string;
    nextBillingAt?: Date;
  }) {
    this._externalSubscriptionId = props.externalSubscriptionId;
    this._authorizationUrl = props.authorizationUrl;
    this._nextBillingAt = props.nextBillingAt;
  }

  assignBillingCard(billingCardId?: string) {
    this._billingCardId = billingCardId;
  }

  updatePlan(props: { planId: string; startedAt: Date }) {
    const expiresAt = Subscription.calculateNextMonthExpiration(
      props.startedAt,
    );

    this._planId = props.planId;
    this._billingStatus = 'ACTIVE';
    this._startedAt = props.startedAt;
    this._expiresAt = expiresAt;
    this._gracePeriodEndsAt = undefined;
    this.recomputeAccessStatus();
  }

  /**
   * Records a downgrade that only takes effect at the end of the paid period.
   *
   * `planId` deliberately stays put: entitlement is driven by it, and the customer
   * paid for the current plan through `effectiveAt`. Downgrading them early would
   * take away access they already bought.
   */
  scheduleDowngrade(props: { planId: string; effectiveAt: Date }) {
    this._pendingPlanId = props.planId;
    this._pendingPlanEffectiveAt = props.effectiveAt;
  }

  /** Drops a scheduled downgrade — e.g. the customer upgraded before it landed. */
  clearScheduledDowngrade() {
    this._pendingPlanId = undefined;
    this._pendingPlanEffectiveAt = undefined;
  }

  /**
   * Applies a scheduled downgrade once its date has passed. Returns whether
   * anything changed, so the caller only persists on a real transition.
   */
  applyScheduledDowngradeIfDue(now: Date = new Date()): boolean {
    if (!this._pendingPlanId || !this._pendingPlanEffectiveAt) return false;
    if (this._pendingPlanEffectiveAt > now) return false;

    this.updatePlan({ planId: this._pendingPlanId, startedAt: now });
    this.clearScheduledDowngrade();

    return true;
  }

  activatePaidPlan(props: {
    planId: string;
    startedAt: Date;
    billingProvider: 'STRIPE';
    externalSubscriptionId?: string;
    nextBillingAt?: Date;
  }) {
    this.updatePlan({
      planId: props.planId,
      startedAt: props.startedAt,
    });
    this._billingProvider = props.billingProvider;
    this._externalSubscriptionId = props.externalSubscriptionId;
    this._nextBillingAt = props.nextBillingAt;
    this._authorizationUrl = undefined;
    this._canceledAt = undefined;
    this._gracePeriodEndsAt = undefined;
    this.recomputeAccessStatus();
  }

  markPastDue(nextBillingAt?: Date) {
    this._billingStatus = 'PAST_DUE';
    this._nextBillingAt = nextBillingAt;
    if (!this._gracePeriodEndsAt) {
      this._gracePeriodEndsAt = new Date(
        Date.now() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000,
      );
    }
    this.recomputeAccessStatus();
  }

  pause(nextBillingAt?: Date) {
    this._billingStatus = 'PAUSED';
    this._nextBillingAt = nextBillingAt;
    this.recomputeAccessStatus();
  }

  private static calculateNextMonthExpiration(startedAt: Date): Date {
    const year = startedAt.getUTCFullYear();
    const month = startedAt.getUTCMonth();
    const day = startedAt.getUTCDate();

    const lastDayOfNextMonth = new Date(
      Date.UTC(year, month + 2, 0),
    ).getUTCDate();

    const expirationDay = Math.min(day, lastDayOfNextMonth);

    return new Date(Date.UTC(year, month + 1, expirationDay));
  }

  expire() {
    this._billingStatus = 'EXPIRED';
    this.recomputeAccessStatus();
  }

  cancel() {
    this._billingStatus = 'CANCELED';
    this._automaticRenovation = false;
    this._canceledAt = new Date();
    this._gracePeriodEndsAt = undefined;
    this.recomputeAccessStatus();
  }

  syncWithProvider(props: {
    status: BillingStatus;
    nextBillingAt?: Date;
    canceledAt?: Date;
    authorizationUrl?: string;
  }) {
    this._billingStatus = props.status;
    this._nextBillingAt = props.nextBillingAt;
    this._authorizationUrl = props.authorizationUrl;
    this._canceledAt = props.canceledAt;
    if (props.status === 'CANCELED') {
      this._automaticRenovation = false;
      this._gracePeriodEndsAt = undefined;
    }
    if (props.status === 'PAST_DUE' && !this._gracePeriodEndsAt) {
      this._gracePeriodEndsAt = new Date(
        Date.now() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000,
      );
    }
    if (props.status === 'ACTIVE' || props.status === 'TRIALING') {
      this._gracePeriodEndsAt = undefined;
    }
    this.recomputeAccessStatus();
  }

  expireGracePeriod() {
    this._billingStatus = 'UNPAID';
    this._gracePeriodEndsAt = undefined;
    this.recomputeAccessStatus();
  }

  recomputeAccessStatus() {
    if (
      this._billingStatus === 'PAST_DUE' &&
      this._gracePeriodEndsAt &&
      this._gracePeriodEndsAt <= new Date()
    ) {
      this._accessStatus = 'PAYMENT_REQUIRED';
      return;
    }
    this._accessStatus = mapBillingToAccess(this._billingStatus);
  }

  get id() {
    return this._id;
  }

  get accountId() {
    return this._accountId;
  }

  get planId() {
    return this._planId;
  }

  get plan() {
    return this._plan;
  }

  get billingCardId() {
    return this._billingCardId;
  }

  get billingStatus() {
    return this._billingStatus;
  }

  get accessStatus() {
    return this._accessStatus;
  }

  /** @deprecated Use `billingStatus`. Kept as alias to avoid breaking call-sites. */
  get status() {
    return this._billingStatus;
  }

  get billingProvider() {
    return this._billingProvider;
  }

  get startedAt() {
    return this._startedAt;
  }

  get automaticRenovation() {
    return this._automaticRenovation;
  }

  get isAnnual() {
    return this._isAnnual;
  }

  get expiresAt() {
    return this._expiresAt;
  }

  get createdAt() {
    return this._createdAt;
  }

  get externalSubscriptionId() {
    return this._externalSubscriptionId;
  }

  get externalReference() {
    return this._externalReference;
  }

  get authorizationUrl() {
    return this._authorizationUrl;
  }

  get nextBillingAt() {
    return this._nextBillingAt;
  }

  get canceledAt() {
    return this._canceledAt;
  }

  /** Plan a scheduled downgrade will move to, or undefined when none is pending. */
  get pendingPlanId() {
    return this._pendingPlanId;
  }

  /** When the scheduled downgrade takes effect — the end of the paid period. */
  get pendingPlanEffectiveAt() {
    return this._pendingPlanEffectiveAt;
  }

  get gracePeriodEndsAt() {
    return this._gracePeriodEndsAt;
  }

  toJSON() {
    return {
      id: this._id,
      accountId: this.accountId,
      planId: this._planId,
      billingCardId: this._billingCardId,
      plan: this._plan?.toJSON(),
      billingStatus: this._billingStatus,
      accessStatus: this._accessStatus,
      status: this._billingStatus,
      billingProvider: this._billingProvider,
      startedAt: this._startedAt,
      expiresAt: this._expiresAt,
      gracePeriodEndsAt: this._gracePeriodEndsAt,
      externalSubscriptionId: this._externalSubscriptionId,
      externalReference: this._externalReference,
      authorizationUrl: this._authorizationUrl,
      nextBillingAt: this._nextBillingAt,
      canceledAt: this._canceledAt,
      isAnnual: this._isAnnual,
      automaticRenovation: this._automaticRenovation,
      createdAt: this._createdAt,
    };
  }
}
