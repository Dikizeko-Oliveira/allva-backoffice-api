import { randomUUID } from 'crypto';

export const ALERT_CHANNELS = ['EMAIL', 'SLACK'] as const;
export type AlertChannel = (typeof ALERT_CHANNELS)[number];

type AlertRuleProps = {
  id: string;
  source: string;
  threshold: string;
  channel: AlertChannel;
  target: string;
  requiredPermission: string;
  quietHours: unknown;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateAlertRuleProps = {
  source: string;
  threshold: string;
  channel: AlertChannel;
  target: string;
  requiredPermission: string;
  quietHours?: unknown;
  active?: boolean;
};

export type UpdateAlertRuleProps = Partial<CreateAlertRuleProps>;

/**
 * Quando avisar o time, por onde e **quem pode ver** o aviso.
 *
 * `requiredPermission` é o que liga o alerta às áreas do backoffice: um
 * alerta de fatura só aparece (no hub e na lista) para quem tem a permissão
 * que a regra declara.
 */
export class AlertRule {
  private constructor(private props: AlertRuleProps) {}

  static create(props: CreateAlertRuleProps): AlertRule {
    const now = new Date();

    return new AlertRule({
      id: randomUUID(),
      source: props.source,
      threshold: props.threshold,
      channel: props.channel,
      target: props.target,
      requiredPermission: props.requiredPermission,
      quietHours: props.quietHours ?? null,
      active: props.active ?? true,
      createdAt: now,
      updatedAt: now,
    });
  }

  static restore(props: AlertRuleProps): AlertRule {
    return new AlertRule(props);
  }

  update(patch: UpdateAlertRuleProps): void {
    this.props = {
      ...this.props,
      source: patch.source ?? this.props.source,
      threshold: patch.threshold ?? this.props.threshold,
      channel: patch.channel ?? this.props.channel,
      target: patch.target ?? this.props.target,
      requiredPermission:
        patch.requiredPermission ?? this.props.requiredPermission,
      quietHours:
        patch.quietHours !== undefined
          ? patch.quietHours
          : this.props.quietHours,
      active: patch.active ?? this.props.active,
      updatedAt: new Date(),
    };
  }

  get id(): string {
    return this.props.id;
  }

  get source(): string {
    return this.props.source;
  }

  get threshold(): string {
    return this.props.threshold;
  }

  get channel(): AlertChannel {
    return this.props.channel;
  }

  get target(): string {
    return this.props.target;
  }

  get requiredPermission(): string {
    return this.props.requiredPermission;
  }

  get quietHours(): unknown {
    return this.props.quietHours;
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
