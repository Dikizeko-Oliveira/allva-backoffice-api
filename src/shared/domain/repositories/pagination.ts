/** Página pedida a um repositório, já com default e teto aplicados. */
export type PageParams = {
  page: number;
  pageSize: number;
};

/** O formato de página que toda listagem do backoffice-api devolve. */
export type PageResult<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

/** Quantas linhas pular para chegar à página pedida. */
export function offsetOf(params: PageParams): number {
  return (params.page - 1) * params.pageSize;
}
