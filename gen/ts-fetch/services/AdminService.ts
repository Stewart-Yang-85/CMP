/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { AdminApiClientListResponse } from '../models/AdminApiClientListResponse';
import type { AdminApiClientRotateRequest } from '../models/AdminApiClientRotateRequest';
import type { AdminApiClientRotateResponse } from '../models/AdminApiClientRotateResponse';
import type { AdminApiClientStatusResponse } from '../models/AdminApiClientStatusResponse';
import type { AdminJobTestReadyExpiryRunRequest } from '../models/AdminJobTestReadyExpiryRunRequest';
import type { AdminJobTestReadyExpiryRunResponse } from '../models/AdminJobTestReadyExpiryRunResponse';
import type { AdminJobWxSyncDailyUsageRequest } from '../models/AdminJobWxSyncDailyUsageRequest';
import type { AdminJobWxSyncDailyUsageResponse } from '../models/AdminJobWxSyncDailyUsageResponse';
import type { AdminSimActionResponse } from '../models/AdminSimActionResponse';
import type { AdminSimBackdateTestStartRequest } from '../models/AdminSimBackdateTestStartRequest';
import type { AdminSimBackdateTestStartResponse } from '../models/AdminSimBackdateTestStartResponse';
import type { AdminSimEvaluateTestExpiryResponse } from '../models/AdminSimEvaluateTestExpiryResponse';
import type { AdminSimSeedUsageRequest } from '../models/AdminSimSeedUsageRequest';
import type { AdminSimSeedUsageResponse } from '../models/AdminSimSeedUsageResponse';
import type { AdminWxSimStatusResponse } from '../models/AdminWxSimStatusResponse';
import type { AdminWxSyncSimInfoBatchRequest } from '../models/AdminWxSyncSimInfoBatchRequest';
import type { AdminWxSyncSimInfoBatchResponse } from '../models/AdminWxSyncSimInfoBatchResponse';
import type { AuditLogListResponse } from '../models/AuditLogListResponse';
import type { EventListResponse } from '../models/EventListResponse';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class AdminService {
    /**
     * Export Jobs CSV (Admin)
     * Internal admin endpoint to export jobs as CSV with filters.
     * @returns string CSV export of jobs
     * @throws ApiError
     */
    public static adminJobsCsv({
        jobType,
        status,
        requestId,
        sortBy,
        sortOrder = 'desc',
        startDate,
        endDate,
        page = 1,
        limit = 1000,
    }: {
        jobType?: string,
        status?: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED',
        /**
         * Filter jobs by requestId (traceId)
         */
        requestId?: string,
        sortBy?: 'startedAt' | 'finishedAt',
        sortOrder?: 'asc' | 'desc',
        /**
         * Filter jobs started on or after this date
         */
        startDate?: string,
        /**
         * Filter jobs started on or before this date
         */
        endDate?: string,
        page?: number,
        limit?: number,
    }): CancelablePromise<string> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/admin/jobs:csv',
            query: {
                'jobType': jobType,
                'status': status,
                'requestId': requestId,
                'sortBy': sortBy,
                'sortOrder': sortOrder,
                'startDate': startDate,
                'endDate': endDate,
                'page': page,
                'limit': limit,
            },
        });
    }
    /**
     * List Events (Admin)
     * Internal admin endpoint to list events with filters.
     * @returns EventListResponse List of events
     * @throws ApiError
     */
    public static adminEvents({
        eventType,
        tenantId,
        requestId,
        iccid,
        beforeStatus,
        afterStatus,
        reason,
        sortBy,
        sortOrder = 'desc',
        start,
        end,
        page = 1,
        limit = 50,
    }: {
        eventType?: string,
        tenantId?: string,
        requestId?: string,
        /**
         * Filter by payload.iccid
         */
        iccid?: string,
        /**
         * Filter by payload.beforeStatus
         */
        beforeStatus?: string,
        /**
         * Filter by payload.afterStatus
         */
        afterStatus?: string,
        /**
         * Filter by payload.reason
         */
        reason?: string,
        sortBy?: 'occurredAt',
        sortOrder?: 'asc' | 'desc',
        /**
         * Filter events occurred on or after this date
         */
        start?: string,
        /**
         * Filter events occurred on or before this date
         */
        end?: string,
        page?: number,
        limit?: number,
    }): CancelablePromise<EventListResponse> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/admin/events',
            query: {
                'eventType': eventType,
                'tenantId': tenantId,
                'requestId': requestId,
                'iccid': iccid,
                'beforeStatus': beforeStatus,
                'afterStatus': afterStatus,
                'reason': reason,
                'sortBy': sortBy,
                'sortOrder': sortOrder,
                'start': start,
                'end': end,
                'page': page,
                'limit': limit,
            },
        });
    }
    /**
     * Get WXZHONGGENG SIM Status (Admin)
     * Fetch real-time status from WXZHONGGENG API.
     * @returns AdminWxSimStatusResponse WXZHONGGENG SIM status
     * @throws ApiError
     */
    public static getAdminWxSimsStatus({
        iccid,
    }: {
        iccid: string,
    }): CancelablePromise<AdminWxSimStatusResponse> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/admin/wx/sims/{iccid}/status',
            path: {
                'iccid': iccid,
            },
        });
    }
    /**
     * Sync WXZHONGGENG SIM Info Batch (Admin)
     * Batch sync SIM info from WXZHONGGENG API via background job.
     * @returns AdminWxSyncSimInfoBatchResponse Sync job accepted
     * @throws ApiError
     */
    public static postAdminJobs:wxSyncSimInfoBatch({
        requestBody,
    }: {
        requestBody: AdminWxSyncSimInfoBatchRequest,
    }): CancelablePromise<AdminWxSyncSimInfoBatchResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/admin/jobs:wx-sync-sim-info-batch',
            body: requestBody,
            mediaType: 'application/json',
        });
    }
    /**
     * List API Clients (Admin)
     * Internal admin endpoint to list downstream API clients.
     * @returns AdminApiClientListResponse List of API clients
     * @throws ApiError
     */
    public static getAdminApiClients({
        enterpriseId,
        status,
        sortBy,
        sortOrder = 'desc',
        page = 1,
        limit = 50,
    }: {
        /**
         * Filter by tenant UUID
         */
        enterpriseId?: string,
        status?: 'ACTIVE' | 'INACTIVE',
        sortBy?: 'createdAt' | 'rotatedAt',
        sortOrder?: 'asc' | 'desc',
        page?: number,
        limit?: number,
    }): CancelablePromise<AdminApiClientListResponse> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/admin/api-clients',
            query: {
                'enterpriseId': enterpriseId,
                'status': status,
                'sortBy': sortBy,
                'sortOrder': sortOrder,
                'page': page,
                'limit': limit,
            },
        });
    }
    /**
     * Export API Clients CSV (Admin)
     * Returns CSV content for API clients based on filters.
     * @returns string CSV export
     * @throws ApiError
     */
    public static adminApiClientsCsv({
        enterpriseId,
        status,
        sortBy,
        sortOrder = 'desc',
        page = 1,
        limit = 1000,
    }: {
        /**
         * Filter by tenant UUID
         */
        enterpriseId?: string,
        status?: 'ACTIVE' | 'INACTIVE',
        sortBy?: 'createdAt' | 'rotatedAt',
        sortOrder?: 'asc' | 'desc',
        page?: number,
        limit?: number,
    }): CancelablePromise<string> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/admin/api-clients:csv',
            query: {
                'enterpriseId': enterpriseId,
                'status': status,
                'sortBy': sortBy,
                'sortOrder': sortOrder,
                'page': page,
                'limit': limit,
            },
        });
    }
    /**
     * Rotate API Client Secret (Admin)
     * Generates (or accepts) a new clientSecret and returns it once.
     * @returns AdminApiClientRotateResponse New secret
     * @throws ApiError
     */
    public static adminApiClientsRotate({
        clientId,
        requestBody,
    }: {
        clientId: string,
        requestBody?: AdminApiClientRotateRequest,
    }): CancelablePromise<AdminApiClientRotateResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/admin/api-clients/{clientId}:rotate',
            path: {
                'clientId': clientId,
            },
            body: requestBody,
            mediaType: 'application/json',
        });
    }
    /**
     * Deactivate API Client (Admin)
     * Disables an API client so it can no longer obtain tokens.
     * @returns AdminApiClientStatusResponse Updated status
     * @throws ApiError
     */
    public static adminApiClientsDeactivate({
        clientId,
    }: {
        clientId: string,
    }): CancelablePromise<AdminApiClientStatusResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/admin/api-clients/{clientId}:deactivate',
            path: {
                'clientId': clientId,
            },
        });
    }
    /**
     * Assign SIM to TEST_READY (Admin)
     * Marks a SIM as TEST_READY and records state history and event.
     * @returns AdminSimActionResponse Assignment success
     * @throws ApiError
     */
    public static adminSimsAssignTest({
        iccid,
    }: {
        iccid: string,
    }): CancelablePromise<AdminSimActionResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/admin/sims/{iccid}:assign-test',
            path: {
                'iccid': iccid,
            },
        });
    }
    /**
     * Reset SIM to INVENTORY (Admin)
     * Resets a SIM status to INVENTORY and records state history and event.
     * @returns AdminSimActionResponse Reset success
     * @throws ApiError
     */
    public static adminSimsResetInventory({
        iccid,
    }: {
        iccid: string,
    }): CancelablePromise<AdminSimActionResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/admin/sims/{iccid}:reset-inventory',
            path: {
                'iccid': iccid,
            },
        });
    }
    /**
     * Reset SIM to ACTIVATED (Admin)
     * Resets a SIM status to ACTIVATED and records state history and event.
     * @returns AdminSimActionResponse Reset success
     * @throws ApiError
     */
    public static adminSimsResetActivated({
        iccid,
    }: {
        iccid: string,
    }): CancelablePromise<AdminSimActionResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/admin/sims/{iccid}:reset-activated',
            path: {
                'iccid': iccid,
            },
        });
    }
    /**
     * Retire SIM (Admin)
     * Retires a SIM; requires DEACTIVATED state and commitment end threshold met.
     * @returns AdminSimActionResponse Retire success
     * @throws ApiError
     */
    public static adminSimsRetire({
        iccid,
    }: {
        iccid: string,
    }): CancelablePromise<AdminSimActionResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/admin/sims/{iccid}:retire',
            path: {
                'iccid': iccid,
            },
        });
    }
    /**
     * Seed usage_daily_summary (Admin)
     * Inserts or updates usage_daily_summary rows for a SIM for smoke/e2e purposes.
     * @returns AdminSimSeedUsageResponse Seed result
     * @throws ApiError
     */
    public static adminSimsSeedUsage({
        iccid,
        requestBody,
    }: {
        iccid: string,
        requestBody?: AdminSimSeedUsageRequest,
    }): CancelablePromise<AdminSimSeedUsageResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/admin/sims/{iccid}:seed-usage',
            path: {
                'iccid': iccid,
            },
            body: requestBody,
            mediaType: 'application/json',
        });
    }
    /**
     * Evaluate TEST_READY Expiry (Admin)
     * Scans TEST_READY SIMs and activates those meeting expiry conditions.
     * @returns AdminSimEvaluateTestExpiryResponse Evaluation summary
     * @throws ApiError
     */
    public static adminSimsEvaluateTestExpiry({
        enterpriseId,
    }: {
        enterpriseId?: string,
    }): CancelablePromise<AdminSimEvaluateTestExpiryResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/admin/sims:evaluate-test-expiry',
            query: {
                'enterpriseId': enterpriseId,
            },
        });
    }
    /**
     * Backdate TEST_READY start (Admin)
     * Backdates the last_status_change_at for TEST_READY to simulate earlier start.
     * @returns AdminSimBackdateTestStartResponse Backdate success
     * @throws ApiError
     */
    public static adminSimsBackdateTestStart({
        iccid,
        requestBody,
    }: {
        iccid: string,
        requestBody?: AdminSimBackdateTestStartRequest,
    }): CancelablePromise<AdminSimBackdateTestStartResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/admin/sims/{iccid}:backdate-test-start',
            path: {
                'iccid': iccid,
            },
            body: requestBody,
            mediaType: 'application/json',
        });
    }
    /**
     * Run TEST_READY Expiry Evaluation Job (Admin)
     * Executes a paginated evaluation over TEST_READY SIMs and activates those meeting expiry conditions.
     * @returns AdminJobTestReadyExpiryRunResponse Job summary
     * @throws ApiError
     */
    public static adminJobsTestReadyExpiryRun({
        requestBody,
    }: {
        requestBody?: AdminJobTestReadyExpiryRunRequest,
    }): CancelablePromise<AdminJobTestReadyExpiryRunResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/admin/jobs:test-ready-expiry-run',
            body: requestBody,
            mediaType: 'application/json',
        });
    }
    /**
     * Run WXZHONGGENG Daily Usage Sync Job (Admin)
     * Syncs daily usage from WXZHONGGENG for SIMs, upserting into usage_daily_summary.
     * @returns AdminJobWxSyncDailyUsageResponse Job summary
     * @throws ApiError
     */
    public static adminJobsWxSyncDailyUsage({
        requestBody,
    }: {
        requestBody?: AdminJobWxSyncDailyUsageRequest,
    }): CancelablePromise<AdminJobWxSyncDailyUsageResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/admin/jobs:wx-sync-daily-usage',
            body: requestBody,
            mediaType: 'application/json',
        });
    }
    /**
     * List Audit Logs (Admin)
     * Internal admin endpoint to query audit logs with filters.
     * @returns AuditLogListResponse List of audit logs
     * @throws ApiError
     */
    public static adminAudits({
        tenantId,
        action,
        sortBy,
        sortOrder = 'desc',
        start,
        end,
        page = 1,
        limit = 50,
    }: {
        tenantId?: string,
        action?: string,
        sortBy?: 'createdAt',
        sortOrder?: 'asc' | 'desc',
        start?: string,
        end?: string,
        page?: number,
        limit?: number,
    }): CancelablePromise<AuditLogListResponse> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/admin/audits',
            query: {
                'tenantId': tenantId,
                'action': action,
                'sortBy': sortBy,
                'sortOrder': sortOrder,
                'start': start,
                'end': end,
                'page': page,
                'limit': limit,
            },
        });
    }
}
