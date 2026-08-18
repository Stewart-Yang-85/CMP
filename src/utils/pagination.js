export function parsePagination(input = {}, options = {}) {
    const defaultPage = Math.max(1, options.defaultPage ?? 1);
    const defaultPageSize = Math.max(1, options.defaultPageSize ?? 50);
    const maxPageSize = Math.max(1, options.maxPageSize ?? 500);
    const rawPage = input.page ?? defaultPage;
    const rawPageSize = input.pageSize ?? defaultPageSize;
    const page = Math.max(1, Number(rawPage) || defaultPage);
    const pageSize = Math.min(maxPageSize, Math.max(1, Number(rawPageSize) || defaultPageSize));
    const offset = Math.max(0, (page - 1) * pageSize);
    return { page, pageSize, offset };
}
export function buildPaginationResponse(items, total, page, pageSize) {
    return { items, total, page, pageSize };
}
