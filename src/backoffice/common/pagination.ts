export type PageQuery = {
  page?: number;
  pageSize?: number;
};

export function normalizePage(query: PageQuery) {
  const page = Math.max(1, Number(query.page ?? 1) || 1);
  const pageSize = Math.min(
    100,
    Math.max(1, Number(query.pageSize ?? 20) || 20),
  );

  return { page, pageSize, skip: (page - 1) * pageSize };
}

export function pageResult<T>(
  items: T[],
  total: number,
  page: number,
  pageSize: number,
) {
  return { items, total, page, pageSize };
}
