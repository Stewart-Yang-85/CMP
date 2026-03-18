export const BILLING_PRECISION: number

export function roundAmount(value: number): number

export function computeMonthlyCharges(
  input: { enterpriseId?: string | null; billPeriod: string; calculationId?: string | null },
  supabase?: any
): Promise<{
  calculationId: string
  totalBillAmount: number
  lineItems: any[]
  ratingResults: any[]
  currency: string
}>

export function generateMonthlyBill(
  job: { payload?: { enterpriseId?: string; billPeriod?: string; calculationId?: string }; job_id?: string },
  supabase?: any
): Promise<{ billId: string | null; skipped?: boolean; totalBillAmount?: number } | void>

export function runBillingTask(job: any): Promise<void>
