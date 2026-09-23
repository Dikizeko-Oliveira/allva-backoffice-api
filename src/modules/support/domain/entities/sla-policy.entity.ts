import { randomUUID } from 'crypto';

type SlaPolicyProps = {
  id: string;
  priority: string;
  category: string | null;
  firstResponseMinutes: number;
  resolutionMinutes: number;
  businessHours: boolean;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateSlaPolicyProps = {
  priority: string;
  category?: string | null;
  firstResponseMinutes: number;
  resolutionMinutes: number;
  businessHours?: boolean;
  active?: boolean;
};

export type UpdateSlaPolicyProps = Partial<{
  priority: string;
  category: string | null;
  firstResponseMinutes: number;
  resolutionMinutes: number;
  businessHours: boolean;
  active: boolean;
}>;

/**
 * Metas de primeira resposta e resolução para uma prioridade (e,
 * opcionalmente, uma categoria). Só uma política **ativa** por escopo — o
 * índice parcial `sla_policies_one_active_per_scope` garante no banco, e os
 * use cases recusam antes com `409`.
 */
export class SlaPolicy {
  private constructor(private props: SlaPolicyProps) {}

  static create(props: CreateSlaPolicyProps): SlaPolicy {
    const now = new Date();

    return new SlaPolicy({
      id: randomUUID(),
      priority: props.priority,
      category: props.category ?? null,
      firstResponseMinutes: props.firstResponseMinutes,
      resolutionMinutes: props.resolutionMinutes,
      businessHours: props.businessHours ?? false,
      active: props.active ?? true,
      createdAt: now,
      updatedAt: now,
    });
  }

  static restore(props: SlaPolicyProps): SlaPolicy {
    return new SlaPolicy(props);
  }

  update(patch: UpdateSlaPolicyProps): void {
    this.props = {
      ...this.props,
      priority: patch.priority ?? this.props.priority,
      category:
        patch.category !== undefined ? patch.category : this.props.category,
      firstResponseMinutes:
        patch.firstResponseMinutes ?? this.props.firstResponseMinutes,
      resolutionMinutes:
        patch.resolutionMinutes ?? this.props.resolutionMinutes,
      businessHours: patch.businessHours ?? this.props.businessHours,
      active: patch.active ?? this.props.active,
      updatedAt: new Date(),
    };
  }

  get id(): string {
    return this.props.id;
  }

  get priority(): string {
    return this.props.priority;
  }

  get category(): string | null {
    return this.props.category;
  }

  get firstResponseMinutes(): number {
    return this.props.firstResponseMinutes;
  }

  get resolutionMinutes(): number {
    return this.props.resolutionMinutes;
  }

  get businessHours(): boolean {
    return this.props.businessHours;
  }

  get active(): boolean {
    return this.props.active;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  get updatedAt(): Date {
    return this.props.updatedAt;
  }
}
