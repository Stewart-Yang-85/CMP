export function buildLifecycleAcceptResponse(input: {
  jobId: string | null
  jobStatus?: string
  sim: Record<string, unknown>
  transition: Record<string, unknown>
}): Record<string, unknown>

export function isLifecycleInProgress(lifecycleSubStatus: unknown): boolean
export function isLifecycleFailed(lifecycleSubStatus: unknown): boolean
export function resolveTransition(sourceAction: string, targetStatus: string): Record<string, unknown> | null
export function processSimStatusChangeJob(input: Record<string, unknown>): Promise<Record<string, unknown>>
