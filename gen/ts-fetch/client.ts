import type { components } from "../types"

type Bill = components["schemas"]["Bill"]
type BillList = components["schemas"]["BillList"]
type SimCard = components["schemas"]["SimCard"]
type SimStatusUpdate = components["schemas"]["SimStatusUpdate"]
type SimPlanChange = components["schemas"]["SimPlanChange"]
type DataUsageRecord = components["schemas"]["DataUsageRecord"]
type BalanceInfo = components["schemas"]["BalanceInfo"]
type ConnectionStatus = components["schemas"]["ConnectionStatus"]

export type Fetcher = (input: RequestInfo, init?: RequestInit) => Promise<Response>

export interface ClientOptions {
  baseUrl?: string
  getHeaders?: () => Record<string, string>
  fetch?: Fetcher
}

function buildQuery(params: Record<string, unknown>) {
  const usp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue
    usp.append(k, String(v))
  }
  const qs = usp.toString()
  return qs ? `?${qs}` : ""
}

export class CMPClient {
  readonly baseUrl: string
  readonly getHeaders: () => Record<string, string>
  readonly fetchImpl: Fetcher

  constructor(opts: ClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://localhost:3000/v1").replace(/\/+$/, "")
    this.getHeaders = opts.getHeaders ?? (() => ({}))
    this.fetchImpl = opts.fetch ?? fetch
  }

  async listBills(params: {
    period?: string
    status?: "GENERATED" | "PUBLISHED" | "PAID" | "OVERDUE" | "WRITTEN_OFF"
    sortBy?: "period" | "dueDate" | "totalAmount" | "status"
    sortOrder?: "asc" | "desc"
    limit?: number
    page?: number
  }): Promise<BillList> {
    const url = `${this.baseUrl}/bills${buildQuery(params)}`
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: { ...this.getHeaders() },
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`listBills failed: ${res.status} ${text}`)
    }
    return text ? (JSON.parse(text) as BillList) : ({ items: [], total: 0 } as BillList)
  }

  async exportBillsCsv(params: {
    period?: string
    status?: "GENERATED" | "PUBLISHED" | "PAID" | "OVERDUE" | "WRITTEN_OFF"
    sortBy?: "period" | "dueDate" | "totalAmount" | "status"
    sortOrder?: "asc" | "desc"
    limit?: number
    page?: number
  }): Promise<string> {
    const url = `${this.baseUrl}/bills:csv${buildQuery(params)}`
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: { ...this.getHeaders() },
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`exportBillsCsv failed: ${res.status} ${text}`)
    }
    return text
  }

  async getBill(billId: string): Promise<Bill> {
    const url = `${this.baseUrl}/bills/${encodeURIComponent(billId)}`
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: { ...this.getHeaders() },
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`getBill failed: ${res.status} ${text}`)
    }
    return text ? (JSON.parse(text) as Bill) : ({} as Bill)
  }

  async getBillFiles(billId: string): Promise<{ pdfUrl: string | null; csvUrl: string }> {
    const url = `${this.baseUrl}/bills/${encodeURIComponent(billId)}/files`
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: { ...this.getHeaders() },
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`getBillFiles failed: ${res.status} ${text}`)
    }
    return text ? (JSON.parse(text) as { pdfUrl: string | null; csvUrl: string }) : { pdfUrl: null, csvUrl: "" }
  }

  async downloadBillCsv(billId: string): Promise<string> {
    const url = `${this.baseUrl}/bills/${encodeURIComponent(billId)}/files/csv`
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: { ...this.getHeaders() },
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`downloadBillCsv failed: ${res.status} ${text}`)
    }
    return text
  }

  async markBillPaid(billId: string, body: { paymentRef?: string; paidAt?: string }): Promise<Bill> {
    const url = `${this.baseUrl}/bills/${encodeURIComponent(billId)}:mark-paid`
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.getHeaders() },
      body: JSON.stringify(body ?? {}),
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`markBillPaid failed: ${res.status} ${text}`)
    }
    return text ? (JSON.parse(text) as Bill) : ({} as Bill)
  }

  async adjustBill(billId: string, body: { type: "CREDIT" | "DEBIT"; amount: number; reason?: string }): Promise<{ noteId?: string }> {
    const url = `${this.baseUrl}/bills/${encodeURIComponent(billId)}:adjust`
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.getHeaders() },
      body: JSON.stringify(body ?? {}),
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`adjustBill failed: ${res.status} ${text}`)
    }
    return text ? (JSON.parse(text) as { noteId?: string }) : {}
  }

  async listSims(params: {
    iccid?: string
    msisdn?: string
    status?: "INVENTORY" | "TEST_READY" | "ACTIVATED" | "DEACTIVATED" | "RETIRED"
    page?: number
    limit?: number
  }): Promise<{ items?: SimCard[]; total?: number }> {
    const url = `${this.baseUrl}/sims${buildQuery(params)}`
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: { ...this.getHeaders() },
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`listSims failed: ${res.status} ${text}`)
    }
    return text ? (JSON.parse(text) as { items?: SimCard[]; total?: number }) : { items: [], total: 0 }
  }

  async exportSimsCsv(params: {
    iccid?: string
    msisdn?: string
    status?: "INVENTORY" | "TEST_READY" | "ACTIVATED" | "DEACTIVATED" | "RETIRED"
    limit?: number
    page?: number
  }): Promise<string> {
    const url = `${this.baseUrl}/sims:csv${buildQuery(params)}`
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: { ...this.getHeaders() },
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`exportSimsCsv failed: ${res.status} ${text}`)
    }
    return text
  }

  async getSim(iccid: string): Promise<SimCard> {
    const url = `${this.baseUrl}/sims/${encodeURIComponent(iccid)}`
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: { ...this.getHeaders() },
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`getSim failed: ${res.status} ${text}`)
    }
    return text ? (JSON.parse(text) as SimCard) : ({} as SimCard)
  }

  async updateSimStatus(iccid: string, body: SimStatusUpdate): Promise<{ jobId?: string; status?: string }> {
    const url = `${this.baseUrl}/sims/${encodeURIComponent(iccid)}`
    const res = await this.fetchImpl(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...this.getHeaders() },
      body: JSON.stringify(body ?? {}),
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`updateSimStatus failed: ${res.status} ${text}`)
    }
    return text ? (JSON.parse(text) as { jobId?: string; status?: string }) : {}
  }

  async changeSimPlan(iccid: string, body: SimPlanChange): Promise<{ success?: boolean; effectiveDate?: string }> {
    const url = `${this.baseUrl}/sims/${encodeURIComponent(iccid)}/plan`
    const res = await this.fetchImpl(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...this.getHeaders() },
      body: JSON.stringify(body ?? {}),
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`changeSimPlan failed: ${res.status} ${text}`)
    }
    return text ? (JSON.parse(text) as { success?: boolean; effectiveDate?: string }) : {}
  }

  async getSimUsage(iccid: string, params: { startDate: string; endDate: string }): Promise<DataUsageRecord[]> {
    const url = `${this.baseUrl}/sims/${encodeURIComponent(iccid)}/usage${buildQuery(params)}`
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: { ...this.getHeaders() },
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`getSimUsage failed: ${res.status} ${text}`)
    }
    return text ? (JSON.parse(text) as DataUsageRecord[]) : []
  }

  async getSimBalance(iccid: string): Promise<BalanceInfo> {
    const url = `${this.baseUrl}/sims/${encodeURIComponent(iccid)}/balance`
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: { ...this.getHeaders() },
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`getSimBalance failed: ${res.status} ${text}`)
    }
    return text ? (JSON.parse(text) as BalanceInfo) : ({} as BalanceInfo)
  }

  async getConnectivityStatus(iccid: string): Promise<ConnectionStatus> {
    const url = `${this.baseUrl}/sims/${encodeURIComponent(iccid)}/connectivity-status`
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: { ...this.getHeaders() },
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`getConnectivityStatus failed: ${res.status} ${text}`)
    }
    return text ? (JSON.parse(text) as ConnectionStatus) : ({} as ConnectionStatus)
  }

  async resetConnection(iccid: string): Promise<{ success?: boolean; message?: string }> {
    const url = `${this.baseUrl}/sims/${encodeURIComponent(iccid)}:reset-connection`
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { ...this.getHeaders() },
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`resetConnection failed: ${res.status} ${text}`)
    }
    return text ? (JSON.parse(text) as { success?: boolean; message?: string }) : {}
  }

  async getSimLocation(iccid: string): Promise<{ visitedMccMnc?: string; country?: string; updatedAt?: string }> {
    const url = `${this.baseUrl}/sims/${encodeURIComponent(iccid)}/location`
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: { ...this.getHeaders() },
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`getSimLocation failed: ${res.status} ${text}`)
    }
    return text ? (JSON.parse(text) as { visitedMccMnc?: string; country?: string; updatedAt?: string }) : {}
  }

  async getSimLocationHistory(iccid: string, params: { startDate: string; endDate: string }): Promise<Array<{ visitedMccMnc?: string; occurredAt?: string }>> {
    const url = `${this.baseUrl}/sims/${encodeURIComponent(iccid)}/location-history${buildQuery(params)}`
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: { ...this.getHeaders() },
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`getSimLocationHistory failed: ${res.status} ${text}`)
    }
    return text ? (JSON.parse(text) as Array<{ visitedMccMnc?: string; occurredAt?: string }>) : []
  }

  async listAdminAudits(params: {
    tenantId?: string
    action?: string
    sortBy?: "createdAt"
    sortOrder?: "asc" | "desc"
    start?: string
    end?: string
    page?: number
    limit?: number
  }): Promise<{
    items?: Array<{
      auditId?: number
      actorUserId?: string | null
      actorRole?: string
      tenantId?: string | null
      action?: string
      targetType?: string
      targetId?: string
      requestId?: string
      sourceIp?: string
      createdAt?: string
    }>
    total?: number
  }> {
    const url = `${this.baseUrl}/admin/audits${buildQuery(params)}`
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: { ...this.getHeaders() },
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`listAdminAudits failed: ${res.status} ${text}`)
    }
    return text
      ? (JSON.parse(text) as {
          items?: Array<{
            auditId?: number
            actorUserId?: string | null
            actorRole?: string
            tenantId?: string | null
            action?: string
            targetType?: string
            targetId?: string
            requestId?: string
            sourceIp?: string
            createdAt?: string
          }>
          total?: number
        })
      : { items: [], total: 0 }
  }

  async exportAdminAuditsCsv(params: {
    tenantId?: string
    action?: string
    sortBy?: "createdAt"
    sortOrder?: "asc" | "desc"
    start?: string
    end?: string
    page?: number
    limit?: number
  }): Promise<string> {
    const url = `${this.baseUrl}/admin/audits:csv${buildQuery(params)}`
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: { ...this.getHeaders() },
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`exportAdminAuditsCsv failed: ${res.status} ${text}`)
    }
    return text
  }

  async getAdminAudit(auditId: string): Promise<{
    auditId?: string
    actorUserId?: string | null
    actorRole?: string
    tenantId?: string | null
    action?: string
    targetType?: string
    targetId?: string
    requestId?: string
    createdAt?: string
    sourceIp?: string | null
    afterData?: Record<string, never>
  }> {
    const url = `${this.baseUrl}/admin/audits/${encodeURIComponent(auditId)}`
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: { ...this.getHeaders() },
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`getAdminAudit failed: ${res.status} ${text}`)
    }
    return text
      ? (JSON.parse(text) as {
          auditId?: string
          actorUserId?: string | null
          actorRole?: string
          tenantId?: string | null
          action?: string
          targetType?: string
          targetId?: string
          requestId?: string
          createdAt?: string
          sourceIp?: string | null
          afterData?: Record<string, never>
        })
      : {}
  }

  async listAdminJobs(params: {
    jobType?: string
    status?: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED"
    requestId?: string
    sortBy?: "startedAt" | "finishedAt"
    sortOrder?: "asc" | "desc"
    startDate?: string
    endDate?: string
    page?: number
    limit?: number
  }): Promise<{
    items?: Array<{
      jobId?: string
      jobType?: string
      status?: string
      progress?: { processed?: number; total?: number }
      startedAt?: string
      finishedAt?: string | null
      requestId?: string
    }>
    total?: number
  }> {
    const url = `${this.baseUrl}/admin/jobs${buildQuery(params)}`
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: { ...this.getHeaders() },
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`listAdminJobs failed: ${res.status} ${text}`)
    }
    return text
      ? (JSON.parse(text) as {
          items?: Array<{
            jobId?: string
            jobType?: string
            status?: string
            progress?: { processed?: number; total?: number }
            startedAt?: string
            finishedAt?: string | null
            requestId?: string
          }>
          total?: number
        })
      : { items: [], total: 0 }
  }

  async getAdminJob(jobId: string): Promise<{
    jobId?: string
    jobType?: string
    status?: string
    progress?: { processed?: number; total?: number }
    startedAt?: string
    finishedAt?: string | null
    requestId?: string
  }> {
    const url = `${this.baseUrl}/admin/jobs/${encodeURIComponent(jobId)}`
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: { ...this.getHeaders() },
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`getAdminJob failed: ${res.status} ${text}`)
    }
    return text
      ? (JSON.parse(text) as {
          jobId?: string
          jobType?: string
          status?: string
          progress?: { processed?: number; total?: number }
          startedAt?: string
          finishedAt?: string | null
          requestId?: string
        })
      : {}
  }

  async listAdminApiClients(params: {
    enterpriseId?: string
    status?: "ACTIVE" | "INACTIVE"
    sortBy?: "createdAt" | "rotatedAt"
    sortOrder?: "asc" | "desc"
    page?: number
    limit?: number
  }): Promise<{
    items?: Array<{
      clientId?: string
      enterpriseId?: string
      status?: string
      createdAt?: string
      rotatedAt?: string | null
    }>
    total?: number
  }> {
    const url = `${this.baseUrl}/admin/api-clients${buildQuery(params)}`
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: { ...this.getHeaders() },
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`listAdminApiClients failed: ${res.status} ${text}`)
    }
    return text
      ? (JSON.parse(text) as {
          items?: Array<{
            clientId?: string
            enterpriseId?: string
            status?: string
            createdAt?: string
            rotatedAt?: string | null
          }>
          total?: number
        })
      : { items: [], total: 0 }
  }

  async exportAdminApiClientsCsv(params: {
    enterpriseId?: string
    status?: "ACTIVE" | "INACTIVE"
    sortBy?: "createdAt" | "rotatedAt"
    sortOrder?: "asc" | "desc"
    page?: number
    limit?: number
  }): Promise<string> {
    const url = `${this.baseUrl}/admin/api-clients:csv${buildQuery(params)}`
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: { ...this.getHeaders() },
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`exportAdminApiClientsCsv failed: ${res.status} ${text}`)
    }
    return text
  }

  async rotateAdminApiClientSecret(clientId: string, body?: { clientSecret?: string }): Promise<{
    clientId?: string
    clientSecret?: string
  }> {
    const url = `${this.baseUrl}/admin/api-clients/${encodeURIComponent(clientId)}:rotate`
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.getHeaders() },
      body: JSON.stringify(body ?? {}),
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`rotateAdminApiClientSecret failed: ${res.status} ${text}`)
    }
    return text
      ? (JSON.parse(text) as {
          clientId?: string
          clientSecret?: string
        })
      : {}
  }

  async deactivateAdminApiClient(clientId: string): Promise<{
    clientId?: string
    status?: string
  }> {
    const url = `${this.baseUrl}/admin/api-clients/${encodeURIComponent(clientId)}:deactivate`
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { ...this.getHeaders() },
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`deactivateAdminApiClient failed: ${res.status} ${text}`)
    }
    return text
      ? (JSON.parse(text) as {
          clientId?: string
          status?: string
        })
      : {}
  }

  async assignSimToTestReady(iccid: string): Promise<{ success?: boolean }> {
    const url = `${this.baseUrl}/admin/sims/${encodeURIComponent(iccid)}:assign-test`
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { ...this.getHeaders() },
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`assignSimToTestReady failed: ${res.status} ${text}`)
    }
    return text ? (JSON.parse(text) as { success?: boolean }) : {}
  }

  async evaluateTestReadyExpiry(params: { enterpriseId?: string }): Promise<{ processed?: number; activated?: number; remaining?: number }> {
    const url = `${this.baseUrl}/admin/sims:evaluate-test-expiry${buildQuery(params)}`
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { ...this.getHeaders() },
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`evaluateTestReadyExpiry failed: ${res.status} ${text}`)
    }
    return text ? (JSON.parse(text) as { processed?: number; activated?: number; remaining?: number }) : {}
  }

  async exportAdminJobsCsv(params: {
    jobType?: string
    status?: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED"
    requestId?: string
    sortBy?: "startedAt" | "finishedAt"
    sortOrder?: "asc" | "desc"
    startDate?: string
    endDate?: string
    page?: number
    limit?: number
  }): Promise<string> {
    const url = `${this.baseUrl}/admin/jobs:csv${buildQuery(params)}`
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: { ...this.getHeaders() },
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`exportAdminJobsCsv failed: ${res.status} ${text}`)
    }
    return text
  }

  async listAdminEvents(params: {
    eventType?: string
    tenantId?: string
    requestId?: string
    sortBy?: "occurredAt"
    sortOrder?: "asc" | "desc"
    start?: string
    end?: string
    page?: number
    limit?: number
  }): Promise<{
    items?: Array<{
      eventId?: string
      eventType?: string
      occurredAt?: string
      tenantId?: string | null
      requestId?: string | null
      jobId?: string | null
      payload?: Record<string, never>
    }>
    total?: number
  }> {
    const url = `${this.baseUrl}/admin/events${buildQuery(params)}`
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: { ...this.getHeaders() },
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`listAdminEvents failed: ${res.status} ${text}`)
    }
    return text
      ? (JSON.parse(text) as {
          items?: Array<{
            eventId?: string
            eventType?: string
            occurredAt?: string
            tenantId?: string | null
            requestId?: string | null
            jobId?: string | null
            payload?: Record<string, never>
          }>
          total?: number
        })
      : { items: [], total: 0 }
  }

  async getAdminEvent(eventId: string): Promise<{
    eventId?: string
    eventType?: string
    occurredAt?: string
    tenantId?: string | null
    requestId?: string | null
    jobId?: string | null
    payload?: Record<string, never>
  }> {
    const url = `${this.baseUrl}/admin/events/${encodeURIComponent(eventId)}`
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: { ...this.getHeaders() },
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`getAdminEvent failed: ${res.status} ${text}`)
    }
    return text
      ? (JSON.parse(text) as {
          eventId?: string
          eventType?: string
          occurredAt?: string
          tenantId?: string | null
          requestId?: string | null
          jobId?: string | null
          payload?: Record<string, never>
        })
      : {}
  }

  async exportAdminEventsCsv(params: {
    eventType?: string
    tenantId?: string
    requestId?: string
    sortBy?: "occurredAt"
    sortOrder?: "asc" | "desc"
    start?: string
    end?: string
    page?: number
    limit?: number
  }): Promise<string> {
    const url = `${this.baseUrl}/admin/events:csv${buildQuery(params)}`
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: { ...this.getHeaders() },
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`exportAdminEventsCsv failed: ${res.status} ${text}`)
    }
    return text
  }

  async runAdminJobTestReadyExpiry(body?: { enterpriseId?: string; pageSize?: number }): Promise<{
    jobId?: string
    processed?: number
    activated?: number
    total?: number
  }> {
    const url = `${this.baseUrl}/admin/jobs:test-ready-expiry-run`
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.getHeaders() },
      body: JSON.stringify(body ?? {}),
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`runAdminJobTestReadyExpiry failed: ${res.status} ${text}`)
    }
    return text
      ? (JSON.parse(text) as {
          jobId?: string
          processed?: number
          activated?: number
          total?: number
        })
      : {}
  }

  async runAdminJobWxSyncDailyUsage(body?: { enterpriseId?: string; startDate?: string; endDate?: string; pageSize?: number }): Promise<{
    jobId?: string
    processed?: number
    total?: number
  }> {
    const url = `${this.baseUrl}/admin/jobs:wx-sync-daily-usage`
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.getHeaders() },
      body: JSON.stringify(body ?? {}),
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`runAdminJobWxSyncDailyUsage failed: ${res.status} ${text}`)
    }
    return text
      ? (JSON.parse(text) as {
          jobId?: string
          processed?: number
          total?: number
        })
      : {}
  }

  async exchangeAccessToken(body: { clientId: string; clientSecret: string }): Promise<{
    accessToken?: string
    expiresIn?: number
  }> {
    const url = `${this.baseUrl}/auth/token`
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.getHeaders() },
      body: JSON.stringify(body ?? {}),
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`exchangeAccessToken failed: ${res.status} ${text}`)
    }
    return text
      ? (JSON.parse(text) as {
          accessToken?: string
          expiresIn?: number
        })
      : {}
  }

  async wxSimOnline(
    xApiKey: string,
    body: {
    messageType: string
    iccid: string
    msisdn: string
    sign: string
    uuid: string
    data: { mncList: string; eventTime: string; mcc: string }
    }
  ): Promise<{ success?: boolean }> {
    const url = `${this.baseUrl}/wx/webhook/sim-online`
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.getHeaders(), "X-API-Key": xApiKey },
      body: JSON.stringify(body ?? {}),
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`wxSimOnline failed: ${res.status} ${text}`)
    }
    return text ? (JSON.parse(text) as { success?: boolean }) : {}
  }

  async wxTrafficAlert(
    xApiKey: string,
    body: {
    messageType: string
    iccid: string
    msisdn: string
    data: {
      thresholdReached: string
      eventTime: string
      limit: string
      eventName: string
      balanceAmount: string
      addOnID: string
    }
    sign: string
    uuid: string
    }
  ): Promise<{ success?: boolean }> {
    const url = `${this.baseUrl}/wx/webhook/traffic-alert`
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.getHeaders(), "X-API-Key": xApiKey },
      body: JSON.stringify(body ?? {}),
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`wxTrafficAlert failed: ${res.status} ${text}`)
    }
    return text ? (JSON.parse(text) as { success?: boolean }) : {}
  }

  async wxProductOrder(
    xApiKey: string,
    body: {
    messageType: string
    iccid: string
    msisdn: string
    data: {
      addOnId: string
      addOnType: string
      startDate: string
      transactionId: string
      expirationDate: string
    }
    sign: string
    uuid: string
    }
  ): Promise<{ success?: boolean }> {
    const url = `${this.baseUrl}/wx/webhook/product-order`
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.getHeaders(), "X-API-Key": xApiKey },
      body: JSON.stringify(body ?? {}),
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`wxProductOrder failed: ${res.status} ${text}`)
    }
    return text ? (JSON.parse(text) as { success?: boolean }) : {}
  }

  async cmpSimStatusChanged(body: { iccid: string; status: "INVENTORY" | "TEST_READY" | "ACTIVATED" | "DEACTIVATED" | "RETIRED" }): Promise<{ success?: boolean; changed?: boolean }> {
    const url = `${this.baseUrl}/cmp/webhook/sim-status-changed`
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.getHeaders() },
      body: JSON.stringify(body ?? {}),
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`cmpSimStatusChanged failed: ${res.status} ${text}`)
    }
    return text ? (JSON.parse(text) as { success?: boolean; changed?: boolean }) : {}
  }

  async wxSimStatusChanged(
    xApiKey: string,
    body: {
    messageType: string
    iccid: string
    msisdn: string
    sign: string
    uuid: string
    data: { toStatus: string; fromStatus: string; eventTime: string; transactionId: string }
    }
  ): Promise<{ success?: boolean }> {
    const url = `${this.baseUrl}/wx/webhook/sim-status-changed`
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.getHeaders(), "X-API-Key": xApiKey },
      body: JSON.stringify(body ?? {}),
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`wxSimStatusChanged failed: ${res.status} ${text}`)
    }
    return text ? (JSON.parse(text) as { success?: boolean }) : {}
  }
}
