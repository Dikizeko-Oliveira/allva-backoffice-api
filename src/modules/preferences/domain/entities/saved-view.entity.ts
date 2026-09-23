import { randomUUID } from 'crypto';

type SavedViewProps = {
  id: string;
  operatorId: string;
  screen: string;
  name: string;
  filters: unknown;
  columns: unknown;
  sort: unknown;
  isDefault: boolean;
  shared: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateSavedViewProps = {
  operatorId: string;
  screen: string;
  name: string;
  filters?: unknown;
  columns?: unknown;
  sort?: unknown;
  isDefault?: boolean;
  shared?: boolean;
};

export type UpdateSavedViewProps = Partial<{
  name: string;
  filters: unknown;
  columns: unknown;
  sort: unknown;
  isDefault: boolean;
  shared: boolean;
}>;

/**
 * Um recorte salvo de uma tela (filtros, colunas, ordenação). Do operador que
 * o criou; `shared` o mostra aos colegas, mas só o dono altera ou apaga.
 *
 * `filters`, `columns` e `sort` são opacos aqui: o formato é da tela que os
 * lê, e o backoffice-api só os guarda.
 */
export class SavedView {
  private constructor(private props: SavedViewProps) {}

  static create(props: CreateSavedViewProps): SavedView {
    const now = new Date();

    return new SavedView({
      id: randomUUID(),
      operatorId: props.operatorId,
      screen: props.screen,
      name: props.name,
      filters: props.filters ?? {},
      columns: props.columns ?? [],
      sort: props.sort ?? null,
      isDefault: props.isDefault ?? false,
      shared: props.shared ?? false,
      createdAt: now,
      updatedAt: now,
    });
  }

  static restore(props: SavedViewProps): SavedView {
    return new SavedView(props);
  }

  isOwnedBy(operatorId: string): boolean {
    return this.props.operatorId === operatorId;
  }

  /**
   * `undefined` = não mexer. `null` num campo JSON = limpar, e cada um volta
   * ao seu vazio.
   */
  update(patch: UpdateSavedViewProps): void {
    this.props = {
      ...this.props,
      name: patch.name ?? this.props.name,
      filters:
        patch.filters !== undefined
          ? (patch.filters ?? {})
          : this.props.filters,
      columns:
        patch.columns !== undefined
          ? (patch.columns ?? [])
          : this.props.columns,
      sort: patch.sort !== undefined ? patch.sort : this.props.sort,
      isDefault: patch.isDefault ?? this.props.isDefault,
      shared: patch.shared ?? this.props.shared,
      updatedAt: new Date(),
    };
  }

  get id(): string {
    return this.props.id;
  }

  get operatorId(): string {
    return this.props.operatorId;
  }

  get screen(): string {
    return this.props.screen;
  }

  get name(): string {
    return this.props.name;
  }

  get filters(): unknown {
    return this.props.filters;
  }

  get columns(): unknown {
    return this.props.columns;
  }

  get sort(): unknown {
    return this.props.sort;
  }

  get isDefault(): boolean {
    return this.props.isDefault;
  }

  get shared(): boolean {
    return this.props.shared;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  get updatedAt(): Date {
    return this.props.updatedAt;
  }
}
