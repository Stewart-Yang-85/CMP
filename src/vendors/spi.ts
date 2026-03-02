export type ProvisioningResult = {
  ok: boolean
  status: 'ACCEPTED' | 'COMPLETED' | 'FAILED'
  vendorRequestId?: string | null
  message?: string | null
  raw?: unknown
}

export type UsageRecord = {
  iccid: string
  date: string
  uplinkKb: number
  downlinkKb: number
  totalKb: number
  source?: string | null
}

export type CdrFile = {
  name: string
  size?: number | null
  checksum?: string | null
  url?: string | null
}

export type CdrFileResult = {
  ok: boolean
  protocol: 'SFTP' | 'API'
  files: CdrFile[]
  raw?: unknown
}

export type VendorProductMapping = {
  supplierId: string
  externalProductId: string
  packageVersionId?: string | null
  provisioningParameters?: unknown | null
}

export interface ProvisioningSPI {
  activateSim(params: { iccid: string; idempotencyKey: string }): Promise<ProvisioningResult>
  suspendSim(params: { iccid: string; idempotencyKey: string }): Promise<ProvisioningResult>
  changePlan(params: {
    iccid: string
    externalProductId: string
    effectiveAt?: Date
    idempotencyKey: string
  }): Promise<ProvisioningResult>
}

export interface UsageSPI {
  getDailyUsage(params: { iccid: string; date: string }): Promise<UsageRecord[]>
  fetchCdrFiles(params: { supplierId: string; date: string; protocol: 'SFTP' | 'API' }): Promise<CdrFileResult>
}

export interface CatalogSPI {
  mapVendorProduct(params: { supplierId: string; externalProductId: string }): Promise<VendorProductMapping>
}

export type SupplierCapabilities = {
  supportsFutureDatedChange: boolean
  supportsRealTimeUsage: boolean
  supportsSftp: boolean
  supportsWebhookNotification: boolean
  maxBatchSize: number
}

export type SupplierAdapter = ProvisioningSPI &
  UsageSPI &
  CatalogSPI & {
    capabilities: SupplierCapabilities
    supplierKey: string
  }
