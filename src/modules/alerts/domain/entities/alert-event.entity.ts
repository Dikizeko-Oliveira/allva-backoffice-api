type AlertEventProps = {
  id: string;
  ruleId: string;
  /** Da regra que disparou o alerta; decide quem o vê. */
  requiredPermission: string;
  source: string;
  severity: string;
  payload: unknown;
  acknowledgedBy: string | null;
  acknowledgedAt: Date | null;
  createdAt: Date;
};

/** Um disparo de uma `AlertRule`. */
export class AlertEvent {
  private constructor(private props: AlertEventProps) {}

  static restore(props: AlertEventProps): AlertEvent {
    return new AlertEvent(props);
  }

  get isAcknowledged(): boolean {
    return this.props.acknowledgedAt !== null;
  }

  /**
   * Idempotente: reconhecer de novo não troca quem reconheceu primeiro. É o
   * primeiro nome que responde "alguém já viu isto?".
   */
  acknowledge(operatorId: string, now: Date = new Date()): void {
    if (this.isAcknowledged) return;

    this.props.acknowledgedBy = operatorId;
    this.props.acknowledgedAt = now;
  }

  get id(): string {
    return this.props.id;
  }

  get ruleId(): string {
    return this.props.ruleId;
  }

  get requiredPermission(): string {
    return this.props.requiredPermission;
  }

  get source(): string {
    return this.props.source;
  }

  get severity(): string {
    return this.props.severity;
  }

  get payload(): unknown {
    return this.props.payload;
  }

  get acknowledgedBy(): string | null {
    return this.props.acknowledgedBy;
  }

  get acknowledgedAt(): Date | null {
    return this.props.acknowledgedAt;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }
}
