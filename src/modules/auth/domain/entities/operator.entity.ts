type OperatorProps = {
  id: string;
  name: string;
  email: string;
  platformRole: string;
  permissions: readonly string[];
  accessToken: string;
};

/**
 * Quem está operando, como o `allva-api` o descreveu nesta requisição.
 *
 * Não é persistido: o backoffice-api não tem tabela de operadores. `id` é o
 * `account.id` do produto e é o identificador em toda coluna daqui
 * (`author_id`, `operator_id`, `actor_id`…), sem FK — é outro banco.
 *
 * `accessToken` viaja junto porque toda chamada ao produto é feita **em nome
 * do operador**, com o bearer dele: o `allva-api` aplica as próprias guardas e
 * o backoffice-api nunca age com mais poder do que quem clicou.
 */
export class Operator {
  private constructor(private readonly props: OperatorProps) {}

  static restore(props: OperatorProps): Operator {
    return new Operator({ ...props, permissions: [...props.permissions] });
  }

  get id(): string {
    return this.props.id;
  }

  get name(): string {
    return this.props.name;
  }

  get email(): string {
    return this.props.email;
  }

  /** Só para exibição e auditoria. Decisão de acesso é sempre por permissão. */
  get platformRole(): string {
    return this.props.platformRole;
  }

  get permissions(): readonly string[] {
    return this.props.permissions;
  }

  get accessToken(): string {
    return this.props.accessToken;
  }

  can(permission: string): boolean {
    return this.props.permissions.includes(permission);
  }
}
