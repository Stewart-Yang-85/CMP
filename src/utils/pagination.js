export function parsePagination(query = {}, options = {}) {
  const defaultPage = Number.isFinite(options.defaultPage) ? Math.max(1, Number(options.defaultPage)) : 1
  const defaultPageSize = Number.isFinite(options.defaultPageSize) ? Math.max(1, Number(options.defaultPageSize)) : 50
  const maxPageSize = Number.isFinite(options.maxPageSize) ? Math.max(1, Number(options.maxPageSize)) : 1000
  const rawPage = query?.page ?? defaultPage
  const rawPageSize = query?.pageSize ?? query?.limit ?? defaultPageSize
  const page = Math.max(1, Number(rawPage) || defaultPage)
  const pageSize = Math.min(maxPageSize, Math.max(1, Number(rawPageSize) || defaultPageSize))
  const offset = Math.max(0, (page - 1) * pageSize)
  return { page, pageSize, offset }
}
