import { randomUUID } from 'crypto';
import { isContactSalesPlan } from '../plan-catalog';
import { PlanFeature } from './plan-feature.entity';

type CreatePlanProps = {
  name: string;
  type: 'FREE' | 'STARTER' | 'PRO' | 'ENTERPRISE';
  trialDays?: number;
  amount: number;
  amountAnnual?: number | null;
  stripePriceId?: string | null;
  stripePriceIdAnnual?: string | null;
  features?: Array<{
    key?: string;
    name: string;
    enabled: boolean;
    value?: string | null;
    description?: string | null;
    landingHighlight?: boolean;
  }>;
};

type RestorePlanProps = {
  id: string;
  name: string;
  type: 'FREE' | 'STARTER' | 'PRO' | 'ENTERPRISE';
  trialDays: number | null;
  amount: number;
  amountAnnual?: number | null;
  stripePriceId: string | null;
  stripePriceIdAnnual?: string | null;
  createdAt: Date;
  features?: PlanFeature[];
};

export class Plan {
  private _id: string;
  private _name: string;
  private _amount: number;
  private _amountAnnual: number | null;
  private _type: 'FREE' | 'STARTER' | 'PRO' | 'ENTERPRISE';
  private _trialDays: number | null;
  private _stripePriceId: string | null;
  private _stripePriceIdAnnual: string | null;
  private _createdAt: Date;
  private _features: PlanFeature[];

  private constructor(props: RestorePlanProps) {
    this._id = props.id;
    this._name = props.name;
    this._amount = props.amount;
    this._amountAnnual = props.amountAnnual ?? null;
    this._type = props.type;
    this._trialDays = props.trialDays;
    this._stripePriceId = props.stripePriceId;
    this._stripePriceIdAnnual = props.stripePriceIdAnnual ?? null;
    this._createdAt = props.createdAt;
    this._features = props.features ?? [];
  }

  static create(props: CreatePlanProps): Plan {
    return new Plan({
      id: randomUUID(),
      name: props.name,
      type: props.type,
      amount: props.amount,
      amountAnnual: props.amountAnnual ?? null,
      trialDays: props.trialDays ?? null,
      stripePriceId: props.stripePriceId ?? null,
      stripePriceIdAnnual: props.stripePriceIdAnnual ?? null,
      createdAt: new Date(),
      features:
        props.features?.map((feature, index) =>
          PlanFeature.create({
            key: feature.key,
            name: feature.name,
            enabled: feature.enabled,
            value: feature.value,
            description: feature.description,
            sortOrder: index,
            landingHighlight: feature.landingHighlight,
          }),
        ) ?? [],
    });
  }

  static restore(props: RestorePlanProps): Plan {
    return new Plan(props);
  }

  get id() {
    return this._id;
  }

  get name() {
    return this._name;
  }

  get amount() {
    return this._amount;
  }

  get amountAnnual() {
    return this._amountAnnual;
  }

  get type() {
    return this._type;
  }

  get trialDays() {
    return this._trialDays;
  }

  get stripePriceId() {
    return this._stripePriceId;
  }

  get stripePriceIdAnnual() {
    return this._stripePriceIdAnnual;
  }

  get createdAt() {
    return this._createdAt;
  }

  /**
   * O plano se negocia com o comercial em vez de se assinar no autoatendimento.
   *
   * Derivado do catálogo, e não de uma coluna: é packaging, muda com a matriz de
   * planos, e uma coluna no banco daria a um seed desatualizado o poder de
   * reabrir o checkout de um plano que ninguém vende por cartão.
   */
  get contactSalesOnly() {
    return isContactSalesPlan(this._type);
  }

  get features() {
    return [...this._features].sort((a, b) => a.sortOrder - b.sortOrder);
  }

  toJSON() {
    return {
      id: this._id,
      name: this._name,
      amount: this._amount,
      amountAnnual: this._amountAnnual,
      type: this._type,
      trialDays: this._trialDays,
      contactSalesOnly: this.contactSalesOnly,
      stripePriceId: this._stripePriceId,
      stripePriceIdAnnual: this._stripePriceIdAnnual,
      createdAt: this._createdAt,
      features: this.features.map((feature) => feature.toJSON()),
    };
  }
}
