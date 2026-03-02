/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { Bill } from '../models/Bill';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class DefaultService {
    /**
     * List Share Links (Admin)
     * Internal admin endpoint to list persisted share links with filters.
     * @returns any List of share links
     * @throws ApiError
     */
    public static getAdminShareLinks({
        enterpriseId,
        kind,
        code,
        codePrefix,
        codeLike,
        requestId,
        expiresFrom,
        expiresTo,
        status,
        sortBy,
        sortOrder = 'desc',
        page = 1,
        limit = 50,
    }: {
        enterpriseId?: string,
        kind?: string,
        code?: string,
        /**
         * Filter by code prefix (LIKE prefix%)
         */
        codePrefix?: string,
        /**
         * Fuzzy search code (ILIKE %substring%)
         */
        codeLike?: string,
        /**
         * Filter by requestId (traceId)
         */
        requestId?: string,
        /**
         * Filter links expiring on or after this time
         */
        expiresFrom?: string,
        /**
         * Filter links expiring on or before this time
         */
        expiresTo?: string,
        status?: 'active' | 'expired',
        sortBy?: 'expiresAt' | 'createdAt' | 'code',
        sortOrder?: 'asc' | 'desc',
        page?: number,
        limit?: number,
    }): CancelablePromise<{
        items?: Array<{
            code?: string;
            enterpriseId?: string | null;
            kind?: string;
            expiresAt?: string;
            createdAt?: string;
            requestId?: string | null;
            /**
             * Resolved short link URL
             */
            url?: string;
        }>;
        total?: number;
    }> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/admin/share-links',
            query: {
                'enterpriseId': enterpriseId,
                'kind': kind,
                'code': code,
                'codePrefix': codePrefix,
                'codeLike': codeLike,
                'requestId': requestId,
                'expiresFrom': expiresFrom,
                'expiresTo': expiresTo,
                'status': status,
                'sortBy': sortBy,
                'sortOrder': sortOrder,
                'page': page,
                'limit': limit,
            },
        });
    }
    /**
     * Export Share Links CSV (Admin)
     * Internal admin endpoint to export share links as CSV.
     * @returns string CSV export of share links
     * @throws ApiError
     */
    public static adminShareLinksCsv({
        enterpriseId,
        kind,
        code,
        codePrefix,
        codeLike,
        requestId,
        expiresFrom,
        expiresTo,
        status,
        sortBy,
        sortOrder = 'desc',
        page = 1,
        limit = 1000,
    }: {
        enterpriseId?: string,
        kind?: string,
        code?: string,
        /**
         * Filter by code prefix (LIKE prefix%)
         */
        codePrefix?: string,
        /**
         * Fuzzy search code (ILIKE %substring%)
         */
        codeLike?: string,
        /**
         * Filter by requestId (traceId)
         */
        requestId?: string,
        /**
         * Filter links expiring on or after this time
         */
        expiresFrom?: string,
        /**
         * Filter links expiring on or before this time
         */
        expiresTo?: string,
        status?: 'active' | 'expired',
        sortBy?: 'expiresAt' | 'createdAt' | 'code',
        sortOrder?: 'asc' | 'desc',
        page?: number,
        limit?: number,
    }): CancelablePromise<string> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/admin/share-links:csv',
            query: {
                'enterpriseId': enterpriseId,
                'kind': kind,
                'code': code,
                'codePrefix': codePrefix,
                'codeLike': codeLike,
                'requestId': requestId,
                'expiresFrom': expiresFrom,
                'expiresTo': expiresTo,
                'status': status,
                'sortBy': sortBy,
                'sortOrder': sortOrder,
                'page': page,
                'limit': limit,
            },
        });
    }
    /**
     * Invalidate Share Link (Admin)
     * Set share link as expired immediately.
     * @returns any Invalidate success
     * @throws ApiError
     */
    public static adminShareLinksInvalidate({
        code,
    }: {
        code: string,
    }): CancelablePromise<{
        code?: string;
        expiresAt?: string;
        status?: 'INVALIDATED';
    }> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/admin/share-links/{code}:invalidate',
            path: {
                'code': code,
            },
        });
    }
    /**
     * Delete Share Link (Admin)
     * Permanently delete a share link.
     * @returns any Delete success
     * @throws ApiError
     */
    public static deleteAdminShareLinks({
        code,
    }: {
        code: string,
    }): CancelablePromise<{
        code?: string;
        deleted?: boolean;
    }> {
        return __request(OpenAPI, {
            method: 'DELETE',
            url: '/admin/share-links/{code}',
            path: {
                'code': code,
            },
        });
    }
    /**
     * Get Event Detail (Admin)
     * Internal admin endpoint to fetch a single event by eventId.
     * @returns any Event detail
     * @throws ApiError
     */
    public static getAdminEvents({
        eventId,
    }: {
        eventId: string,
    }): CancelablePromise<{
        eventId?: string;
        eventType?: string;
        occurredAt?: string;
        tenantId?: string | null;
        requestId?: string | null;
        jobId?: string | null;
        payload?: Record<string, any>;
    }> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/admin/events/{eventId}',
            path: {
                'eventId': eventId,
            },
        });
    }
    /**
     * Export Events CSV (Admin)
     * Internal admin endpoint to export events as CSV with filters.
     * @returns string CSV export of events
     * @throws ApiError
     */
    public static adminEventsCsv({
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
        limit = 1000,
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
        start?: string,
        end?: string,
        page?: number,
        limit?: number,
    }): CancelablePromise<string> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/admin/events:csv',
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
            errors: {
                401: `Invalid credentials`,
            },
        });
    }
    /**
     * WXZHONGGENG SIM Online Webhook
     * Supplier callback to notify SIM online events.
     * @returns any Accepted
     * @throws ApiError
     */
    public static postWxWebhookSimOnline({
        xApiKey,
        requestBody,
    }: {
        xApiKey: string,
        requestBody: {
            messageType: string;
            iccid: string;
            msisdn: string;
            sign: string;
            uuid: string;
            data: {
                mncList: string;
                eventTime: string;
                mcc: string;
            };
        },
    }): CancelablePromise<{
        success?: boolean;
    }> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/wx/webhook/sim-online',
            headers: {
                'X-API-Key': xApiKey,
            },
            body: requestBody,
            mediaType: 'application/json',
        });
    }
    /**
     * WXZHONGGENG Traffic Alert Webhook
     * Supplier callback to notify data usage alerts.
     * @returns any Accepted
     * @throws ApiError
     */
    public static postWxWebhookTrafficAlert({
        xApiKey,
        requestBody,
    }: {
        xApiKey: string,
        requestBody: {
            messageType: string;
            iccid: string;
            msisdn: string;
            data: {
                thresholdReached: string;
                eventTime: string;
                limit: string;
                eventName: string;
                balanceAmount: string;
                addOnID: string;
            };
            sign: string;
            uuid: string;
        },
    }): CancelablePromise<{
        success?: boolean;
    }> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/wx/webhook/traffic-alert',
            headers: {
                'X-API-Key': xApiKey,
            },
            body: requestBody,
            mediaType: 'application/json',
        });
    }
    /**
     * WXZHONGGENG Product Order Webhook
     * Supplier callback to notify product order events.
     * @returns any Accepted
     * @throws ApiError
     */
    public static postWxWebhookProductOrder({
        xApiKey,
        requestBody,
    }: {
        xApiKey: string,
        requestBody: {
            messageType: string;
            iccid: string;
            msisdn: string;
            data: {
                addOnId: string;
                addOnType: string;
                startDate: string;
                transactionId: string;
                expirationDate: string;
            };
            sign: string;
            uuid: string;
        },
    }): CancelablePromise<{
        success?: boolean;
    }> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/wx/webhook/product-order',
            headers: {
                'X-API-Key': xApiKey,
            },
            body: requestBody,
            mediaType: 'application/json',
        });
    }
    /**
     * WXZHONGGENG SIM Status Changed Webhook
     * Supplier callback to notify SIM status changes.
     * @returns any Accepted
     * @throws ApiError
     */
    public static postWxWebhookSimStatusChanged({
        xApiKey,
        requestBody,
    }: {
        xApiKey: string,
        requestBody: {
            messageType: string;
            iccid: string;
            msisdn: string;
            sign: string;
            uuid: string;
            data: {
                toStatus: string;
                fromStatus: string;
                eventTime: string;
                transactionId: string;
            };
        },
    }): CancelablePromise<{
        success?: boolean;
    }> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/wx/webhook/sim-status-changed',
            headers: {
                'X-API-Key': xApiKey,
            },
            body: requestBody,
            mediaType: 'application/json',
        });
    }
    /**
     * Export Audit Logs as CSV (Admin)
     * Returns CSV content for audit logs based on filters.
     * @returns string CSV export
     * @throws ApiError
     */
    public static adminAuditsCsv({
        tenantId,
        action,
        sortBy,
        sortOrder = 'desc',
        start,
        end,
        page = 1,
        limit = 1000,
    }: {
        tenantId?: string,
        action?: string,
        sortBy?: 'createdAt',
        sortOrder?: 'asc' | 'desc',
        start?: string,
        end?: string,
        page?: number,
        limit?: number,
    }): CancelablePromise<string> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/admin/audits:csv',
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
    /**
     * Get Audit Detail (Admin)
     * Internal admin endpoint to fetch a single audit log by auditId.
     * @returns any Audit detail
     * @throws ApiError
     */
    public static getAdminAudits({
        auditId,
    }: {
        auditId: string,
    }): CancelablePromise<{
        auditId?: string;
        actorUserId?: string | null;
        actorRole?: string;
        tenantId?: string | null;
        action?: string;
        targetType?: string;
        targetId?: string;
        requestId?: string;
        createdAt?: string;
        sourceIp?: string | null;
        afterData?: Record<string, any>;
    }> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/admin/audits/{auditId}',
            path: {
                'auditId': auditId,
            },
        });
    }
    /**
     * List Jobs (Admin)
     * Internal admin endpoint to list background jobs.
     * @returns any List of jobs
     * @throws ApiError
     */
    public static getAdminJobs({
        jobType,
        status,
        requestId,
        sortBy,
        sortOrder = 'desc',
        startDate,
        endDate,
        page = 1,
        limit = 50,
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
    }): CancelablePromise<{
        items?: Array<{
            jobId?: string;
            jobType?: string;
            status?: string;
            progress?: {
                processed?: number;
                total?: number;
            };
            startedAt?: string;
            finishedAt?: string | null;
            requestId?: string;
        }>;
        total?: number;
    }> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/admin/jobs',
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
     * Get Job Detail (Admin)
     * Internal admin endpoint to fetch a single job by jobId.
     * @returns any Job detail
     * @throws ApiError
     */
    public static getAdminJobs1({
        jobId,
    }: {
        jobId: string,
    }): CancelablePromise<{
        jobId?: string;
        jobType?: string;
        status?: string;
        progress?: {
            processed?: number;
            total?: number;
        };
        startedAt?: string;
        finishedAt?: string | null;
        requestId?: string;
    }> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/admin/jobs/{jobId}',
            path: {
                'jobId': jobId,
            },
        });
    }
    /**
     * CMP Webhook - SIM Status Changed
     * Upstream CMP calls this webhook when a SIM lifecycle status changes.
     * @returns any Webhook processed
     * @throws ApiError
     */
    public static postCmpWebhookSimStatusChanged({
        requestBody,
    }: {
        requestBody: {
            iccid: string;
            status: 'INVENTORY' | 'TEST_READY' | 'ACTIVATED' | 'DEACTIVATED' | 'RETIRED';
        },
    }): CancelablePromise<{
        success?: boolean;
        changed?: boolean;
    }> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/cmp/webhook/sim-status-changed',
            body: requestBody,
            mediaType: 'application/json',
        });
    }
    /**
     * Mark Bill as Paid
     * @returns Bill Updated bill
     * @throws ApiError
     */
    public static postBills-:markPaid({
        billId,
        requestBody,
    }: {
        billId: string,
        requestBody: {
            paymentRef?: string;
            paidAt?: string;
        },
    }): CancelablePromise<Bill> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/bills/{billId}:mark-paid',
            path: {
                'billId': billId,
            },
            body: requestBody,
            mediaType: 'application/json',
        });
    }
    /**
     * Create Adjustment Note
     * @returns any Adjustment note created
     * @throws ApiError
     */
    public static postBills-:adjust({
        billId,
        requestBody,
    }: {
        billId: string,
        requestBody: {
            type: 'CREDIT' | 'DEBIT';
            amount: number;
            reason?: string;
        },
    }): CancelablePromise<{
        noteId?: string;
    }> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/bills/{billId}:adjust',
            path: {
                'billId': billId,
            },
            body: requestBody,
            mediaType: 'application/json',
        });
    }
}
