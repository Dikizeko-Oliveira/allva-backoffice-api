import type { PageRequest } from 'src/modules/platform-admin/domain/read-models';

/** Os padrões das listas administrativas: página 1, vinte por página. */
export function pageRequestOf(query: {
  page?: number;
  pageSize?: number;
}): PageRequest {
  return { page: query.page ?? 1, pageSize: query.pageSize ?? 20 };
}
