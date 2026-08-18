type SupabaseClient = {
  select: (table: string, queryString: string) => Promise<unknown>
}

export type OperatorRow = {
  operator_id: string
  supplier_id: string
  business_operator_id: string | null
}

export async function loadOperatorByOperatorId(
  supabase: SupabaseClient,
  operatorId: string,
  supplierId?: string | null
): Promise<OperatorRow | null> {
  const supplierFilter = supplierId ? `&supplier_id=eq.${encodeURIComponent(supplierId)}` : ''
  const rows = await supabase.select(
    'operators',
    `select=operator_id,supplier_id,business_operator_id&operator_id=eq.${encodeURIComponent(operatorId)}${supplierFilter}&limit=1`
  )
  const row = Array.isArray(rows) ? rows[0] : null
  return row && (row as OperatorRow).operator_id ? (row as OperatorRow) : null
}

export async function loadOperatorByBusinessOperatorId(
  supabase: SupabaseClient,
  businessOperatorId: string,
  supplierId?: string | null
): Promise<OperatorRow | null> {
  const supplierFilter = supplierId ? `&supplier_id=eq.${encodeURIComponent(supplierId)}` : ''
  const rows = await supabase.select(
    'operators',
    `select=operator_id,supplier_id,business_operator_id&business_operator_id=eq.${encodeURIComponent(businessOperatorId)}${supplierFilter}&limit=1`
  )
  const row = Array.isArray(rows) ? rows[0] : null
  return row && (row as OperatorRow).operator_id ? (row as OperatorRow) : null
}

/** Resolves supplier-scoped operators row: try operators.operator_id first, then business_operator_id. */
export async function loadOperator(
  supabase: SupabaseClient,
  operatorId: string,
  supplierId?: string | null
): Promise<OperatorRow | null> {
  const byOperatorId = await loadOperatorByOperatorId(supabase, operatorId, supplierId)
  if (byOperatorId) return byOperatorId
  return loadOperatorByBusinessOperatorId(supabase, operatorId, supplierId)
}

export async function businessOperatorDisplayIdByOperatorRowId(
  supabase: SupabaseClient,
  operatorRowId: string
): Promise<string> {
  const rows = await supabase.select(
    'operators',
    `select=operator_id,business_operator_id&operator_id=eq.${encodeURIComponent(operatorRowId)}&limit=1`
  )
  const row = Array.isArray(rows) ? rows[0] : null
  const pk = row?.operator_id != null ? String(row.operator_id) : operatorRowId
  const bo = row?.business_operator_id != null ? String(row.business_operator_id).trim() : ''
  return bo || pk
}
