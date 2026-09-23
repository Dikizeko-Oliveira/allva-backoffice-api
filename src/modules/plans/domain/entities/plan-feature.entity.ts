import { randomUUID } from 'crypto';
import { type FeatureSection, sectionFor } from '../plan-catalog';

type CreatePlanFeatureProps = {
  /**
   * Slug estável, igual nos quatro planos. Opcional na entrada porque o
   * endpoint administrativo de criação de plano é anterior a ele: ausente, é
   * derivado de `name`, o que mantém a coluna NOT NULL sem quebrar o contrato.
   */
  key?: string;
  name: string;
  enabled: boolean;
  value?: string | null;
  description?: string | null;
  sortOrder?: number;
  /** A linha aparece no card do plano. @default false */
  landingHighlight?: boolean;
};

type RestorePlanFeatureProps = {
  id: string;
  key: string;
  name: string;
  enabled: boolean;
  value?: string | null;
  description?: string | null;
  sortOrder: number;
  landingHighlight: boolean;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * `name` é rótulo e `value` é o limite ("300", "13 meses", "Somente leitura").
 * Separá-los é o que permite a tabela comparativa da landing agrupar por `key`
 * — com o número embutido no rótulo, a mesma feature vira quatro linhas que
 * nada relaciona.
 */
export function slugifyFeatureKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export class PlanFeature {
  private _id: string;
  private _key: string;
  private _name: string;
  private _enabled: boolean;
  private _value: string | null;
  private _description: string | null;
  private _sortOrder: number;
  private _landingHighlight: boolean;
  private _createdAt: Date;
  private _updatedAt: Date;

  private constructor(props: RestorePlanFeatureProps) {
    this._id = props.id;
    this._key = props.key;
    this._name = props.name;
    this._enabled = props.enabled;
    this._value = props.value ?? null;
    this._description = props.description ?? null;
    this._sortOrder = props.sortOrder;
    this._landingHighlight = props.landingHighlight;
    this._createdAt = props.createdAt;
    this._updatedAt = props.updatedAt;
  }

  static create(props: CreatePlanFeatureProps): PlanFeature {
    const now = new Date();

    return new PlanFeature({
      id: randomUUID(),
      key: props.key ?? slugifyFeatureKey(props.name),
      name: props.name,
      enabled: props.enabled,
      value: props.value ?? null,
      description: props.description ?? null,
      sortOrder: props.sortOrder ?? 0,
      landingHighlight: props.landingHighlight ?? false,
      createdAt: now,
      updatedAt: now,
    });
  }

  static restore(props: RestorePlanFeatureProps): PlanFeature {
    return new PlanFeature(props);
  }

  get id() {
    return this._id;
  }

  get key() {
    return this._key;
  }

  get name() {
    return this._name;
  }

  get enabled() {
    return this._enabled;
  }

  get value() {
    return this._value;
  }

  get description() {
    return this._description;
  }

  get sortOrder() {
    return this._sortOrder;
  }

  get landingHighlight() {
    return this._landingHighlight;
  }

  /**
   * A seção da tabela comparativa.
   *
   * Derivada, e por isso sem coluna: os blocos de `sortOrder` já decidem o
   * agrupamento, e uma coluna paralela poderia discordar deles — uma linha com
   * `sortOrder: 41` gravada como "Operação" apareceria sob Governança para quem
   * ordenasse e sob Operação para quem lesse a coluna.
   */
  get section(): FeatureSection {
    return sectionFor(this._sortOrder);
  }

  get createdAt() {
    return this._createdAt;
  }

  get updatedAt() {
    return this._updatedAt;
  }

  toJSON() {
    return {
      id: this._id,
      key: this._key,
      name: this._name,
      enabled: this._enabled,
      value: this._value,
      description: this._description,
      sortOrder: this._sortOrder,
      landingHighlight: this._landingHighlight,
      section: this.section,
      createdAt: this._createdAt,
      updatedAt: this._updatedAt,
    };
  }
}
