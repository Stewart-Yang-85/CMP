export function parsePagination(query, options = {}) {
  const limitDefault = Number.isFinite(options.limitDefault) ? Number(options.limitDefault) : 50
  const limitMax = Number.isFinite(options.limitMax) ? Number(options.limitMax) : 1000
  const pageDefault = Number.isFinite(options.pageDefault) ? Number(options.pageDefault) : 1
  const limitRaw = query?.limit
  const pageRaw = query?.page
  const limitNum = Number(limitRaw)
  const pageNum = Number(pageRaw)
  const limit = Number.isFinite(limitNum) && limitNum > 0 ? Math.min(limitNum, limitMax) : limitDefault
  const page = Number.isFinite(pageNum) && pageNum > 0 ? Math.floor(pageNum) : pageDefault
  const offset = Math.max(0, (Math.max(1, page) - 1) * Math.max(0, limit))
  return { limit, page, offset }
}
