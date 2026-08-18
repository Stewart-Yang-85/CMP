export type PackageVersionsCatalogSnap =
  | { kind: 'business_filter_empty'; filterStr?: string }
  | {
      kind: 'ok'
      items: unknown[]
      total: number
      filterStr: string
      csvRows: string[][]
    }

export function fetchPackageVersionsCatalog(args: Record<string, unknown>): Promise<PackageVersionsCatalogSnap>
