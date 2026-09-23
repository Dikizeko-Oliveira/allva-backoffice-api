type OperatorPreferenceProps = {
  operatorId: string;
  lastWorkspace: string | null;
  sidebarCollapsed: boolean;
  density: string;
  timezone: string | null;
  updatedAt: Date | null;
};

export type ReplaceOperatorPreferenceProps = {
  lastWorkspace?: string | null;
  sidebarCollapsed?: boolean;
  density?: string;
  timezone?: string | null;
};

const DEFAULT_DENSITY = 'comfortable';

/**
 * Como o backoffice-web se apresenta para um operador. Uma linha por operador,
 * criada no primeiro `PUT` — até lá, valem os defaults, e `updatedAt: null`
 * diz que ninguém salvou nada.
 */
export class OperatorPreference {
  private constructor(private props: OperatorPreferenceProps) {}

  static defaultsFor(operatorId: string): OperatorPreference {
    return new OperatorPreference({
      operatorId,
      lastWorkspace: null,
      sidebarCollapsed: false,
      density: DEFAULT_DENSITY,
      timezone: null,
      updatedAt: null,
    });
  }

  static restore(props: OperatorPreferenceProps): OperatorPreference {
    return new OperatorPreference(props);
  }

  /** `PUT`: o que não veio volta ao default, não fica como estava. */
  replace(input: ReplaceOperatorPreferenceProps): void {
    this.props = {
      operatorId: this.props.operatorId,
      lastWorkspace: input.lastWorkspace ?? null,
      sidebarCollapsed: input.sidebarCollapsed ?? false,
      density: input.density ?? DEFAULT_DENSITY,
      timezone: input.timezone ?? null,
      updatedAt: new Date(),
    };
  }

  get operatorId(): string {
    return this.props.operatorId;
  }

  get lastWorkspace(): string | null {
    return this.props.lastWorkspace;
  }

  get sidebarCollapsed(): boolean {
    return this.props.sidebarCollapsed;
  }

  get density(): string {
    return this.props.density;
  }

  get timezone(): string | null {
    return this.props.timezone;
  }

  get updatedAt(): Date | null {
    return this.props.updatedAt;
  }
}
