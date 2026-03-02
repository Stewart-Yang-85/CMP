export function computeMonthlyCharges(
  input: { enterpriseId?: string | null; billPeriod: string; calculationId?: string | null },
  supabase: any
): Promise<{
  totalBillAmount: number
  lineItems: any[]
  ratingResults: any[]
  currency?: string | null
}>
