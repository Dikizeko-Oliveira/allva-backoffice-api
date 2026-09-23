import { randomUUID } from 'crypto';

export const SalesLeadStatusValues = [
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'PROPOSAL_SENT',
  'NEGOTIATION',
  'CLOSED_WON',
  'CLOSED_LOST',
] as const;

export type SalesLeadStatus = (typeof SalesLeadStatusValues)[number];

const TERMINAL_STATUSES: ReadonlyArray<SalesLeadStatus> = [
  'CLOSED_WON',
  'CLOSED_LOST',
];

type CreateSalesLeadProps = {
  accountId?: string | null;
  companyName: string;
  workEmail: string;
  fullName: string;
  phone?: string | null;
  estimatedMonthlySpend?: number | null;
  teamSize?: number | null;
  platforms?: string[] | null;
  notes?: string | null;
  desiredPlan: string;
  source?: string | null;
  assignedTo?: string | null;
  metadata?: Record<string, unknown> | null;
};

type RestoreSalesLeadProps = {
  id: string;
  accountId: string | null;
  companyName: string;
  workEmail: string;
  fullName: string;
  phone: string | null;
  estimatedMonthlySpend: number | null;
  teamSize: number | null;
  platforms: string[] | null;
  notes: string | null;
  desiredPlan: string;
  status: SalesLeadStatus;
  source: string | null;
  assignedTo: string | null;
  qualifiedAt: Date | null;
  closedWonAt: Date | null;
  closedLostAt: Date | null;
  metadata: Record<string, unknown> | null;
  provisionedOrganizationId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export class SalesLead {
  private _id: string;
  private _accountId: string | null;
  private _companyName: string;
  private _workEmail: string;
  private _fullName: string;
  private _phone: string | null;
  private _estimatedMonthlySpend: number | null;
  private _teamSize: number | null;
  private _platforms: string[] | null;
  private _notes: string | null;
  private _desiredPlan: string;
  private _status: SalesLeadStatus;
  private _source: string | null;
  private _assignedTo: string | null;
  private _qualifiedAt: Date | null;
  private _closedWonAt: Date | null;
  private _closedLostAt: Date | null;
  private _metadata: Record<string, unknown> | null;
  private _provisionedOrganizationId: string | null;
  private _createdAt: Date;
  private _updatedAt: Date;

  private constructor(props: RestoreSalesLeadProps) {
    this._id = props.id;
    this._accountId = props.accountId;
    this._companyName = props.companyName;
    this._workEmail = props.workEmail;
    this._fullName = props.fullName;
    this._phone = props.phone;
    this._estimatedMonthlySpend = props.estimatedMonthlySpend;
    this._teamSize = props.teamSize;
    this._platforms = props.platforms;
    this._notes = props.notes;
    this._desiredPlan = props.desiredPlan;
    this._status = props.status;
    this._source = props.source;
    this._assignedTo = props.assignedTo;
    this._qualifiedAt = props.qualifiedAt;
    this._closedWonAt = props.closedWonAt;
    this._closedLostAt = props.closedLostAt;
    this._metadata = props.metadata;
    this._provisionedOrganizationId = props.provisionedOrganizationId;
    this._createdAt = props.createdAt;
    this._updatedAt = props.updatedAt;
  }

  static create(props: CreateSalesLeadProps): SalesLead {
    const now = new Date();

    return new SalesLead({
      id: randomUUID(),
      accountId: props.accountId ?? null,
      companyName: props.companyName,
      workEmail: props.workEmail,
      fullName: props.fullName,
      phone: props.phone ?? null,
      estimatedMonthlySpend: props.estimatedMonthlySpend ?? null,
      teamSize: props.teamSize ?? null,
      platforms: props.platforms ?? null,
      notes: props.notes ?? null,
      desiredPlan: props.desiredPlan,
      status: 'NEW',
      source: props.source ?? null,
      assignedTo: props.assignedTo ?? null,
      qualifiedAt: null,
      closedWonAt: null,
      closedLostAt: null,
      metadata: props.metadata ?? null,
      provisionedOrganizationId: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  static restore(props: RestoreSalesLeadProps): SalesLead {
    return new SalesLead(props);
  }

  /**
   * Transitions the lead to a new pipeline status, stamping the lifecycle
   * timestamps (qualified/won/lost) as the lead moves forward. Terminal
   * statuses (CLOSED_WON / CLOSED_LOST) cannot be changed afterwards.
   */
  changeStatus(next: SalesLeadStatus): void {
    if (this._status === next) {
      return;
    }

    if (TERMINAL_STATUSES.includes(this._status)) {
      throw new Error('SALES_LEAD_ALREADY_CLOSED');
    }

    const now = new Date();
    this._status = next;
    this._updatedAt = now;

    if (next === 'QUALIFIED' && !this._qualifiedAt) {
      this._qualifiedAt = now;
    }

    if (next === 'CLOSED_WON') {
      this._closedWonAt = now;
      if (!this._qualifiedAt) this._qualifiedAt = now;
    }

    if (next === 'CLOSED_LOST') {
      this._closedLostAt = now;
    }
  }

  assignTo(assignee: string | null): void {
    this._assignedTo = assignee;
    this._updatedAt = new Date();
  }

  get id() {
    return this._id;
  }

  get accountId() {
    return this._accountId;
  }

  get companyName() {
    return this._companyName;
  }

  get workEmail() {
    return this._workEmail;
  }

  get fullName() {
    return this._fullName;
  }

  get phone() {
    return this._phone;
  }

  get estimatedMonthlySpend() {
    return this._estimatedMonthlySpend;
  }

  get teamSize() {
    return this._teamSize;
  }

  get platforms() {
    return this._platforms;
  }

  get notes() {
    return this._notes;
  }

  get desiredPlan() {
    return this._desiredPlan;
  }

  get status() {
    return this._status;
  }

  get source() {
    return this._source;
  }

  get assignedTo() {
    return this._assignedTo;
  }

  get qualifiedAt() {
    return this._qualifiedAt;
  }

  get closedWonAt() {
    return this._closedWonAt;
  }

  get closedLostAt() {
    return this._closedLostAt;
  }

  get metadata() {
    return this._metadata;
  }

  get provisionedOrganizationId() {
    return this._provisionedOrganizationId;
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
      accountId: this._accountId,
      companyName: this._companyName,
      workEmail: this._workEmail,
      fullName: this._fullName,
      phone: this._phone,
      estimatedMonthlySpend: this._estimatedMonthlySpend,
      teamSize: this._teamSize,
      platforms: this._platforms,
      notes: this._notes,
      desiredPlan: this._desiredPlan,
      status: this._status,
      source: this._source,
      assignedTo: this._assignedTo,
      qualifiedAt: this._qualifiedAt,
      closedWonAt: this._closedWonAt,
      closedLostAt: this._closedLostAt,
      metadata: this._metadata,
      provisionedOrganizationId: this._provisionedOrganizationId,
      createdAt: this._createdAt,
      updatedAt: this._updatedAt,
    };
  }
}
