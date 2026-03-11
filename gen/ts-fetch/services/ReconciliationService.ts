/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ReconciliationMismatchListResponse } from '../models/ReconciliationMismatchListResponse';
import type { ReconciliationMismatchTraceResponse } from '../models/ReconciliationMismatchTraceResponse';
import type { ReconciliationRunDetailResponse } from '../models/ReconciliationRunDetailResponse';
import type { ReconciliationRunListResponse } from '../models/ReconciliationRunListResponse';
import type { ReconciliationRunQueuedResponse } from '../models/ReconciliationRunQueuedResponse';
import type { ReconciliationRunRequest } from '../models/ReconciliationRunRequest';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class ReconciliationService {
    /**
     * List Reconciliation Runs
     * List reconciliation runs with filters.
     * @returns ReconciliationRunListResponse Reconciliation runs
     * @throws ApiError
     */
    public static getReconciliationRuns({
        supplierId,
        date,
        scope,
        status,
        page = 1,
        pageSize = 20,
    }: {
        supplierId?: string,
        date?: string,
        scope?: 'FULL' | 'INCREMENTAL',
        status?: 'RUNNING' | 'COMPLETED' | 'FAILED',
        page?: number,
        pageSize?: number,
    }): CancelablePromise<ReconciliationRunListResponse> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/reconciliation/runs',
            query: {
                'supplierId': supplierId,
                'date': date,
                'scope': scope,
                'status': status,
                'page': page,
                'pageSize': pageSize,
            },
            errors: {
                400: `Validation error`,
                401: `Unauthorized`,
                403: `Forbidden`,
                404: `Resource not found`,
            },
        });
    }
    /**
     * Create Reconciliation Run
     * Trigger a reconciliation run for a supplier and date.
     * @returns ReconciliationRunQueuedResponse Reconciliation run accepted
     * @throws ApiError
     */
    public static postReconciliationRuns({
        requestBody,
    }: {
        requestBody: ReconciliationRunRequest,
    }): CancelablePromise<ReconciliationRunQueuedResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/reconciliation/runs',
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Validation error`,
                401: `Unauthorized`,
                403: `Forbidden`,
            },
        });
    }
    /**
     * Get Reconciliation Run
     * @returns ReconciliationRunDetailResponse Reconciliation run detail
     * @throws ApiError
     */
    public static getReconciliationRuns1({
        runId,
    }: {
        runId: string,
    }): CancelablePromise<ReconciliationRunDetailResponse> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/reconciliation/runs/{runId}',
            path: {
                'runId': runId,
            },
            errors: {
                400: `Validation error`,
                401: `Unauthorized`,
                403: `Forbidden`,
                404: `Not found`,
            },
        });
    }
    /**
     * List Reconciliation Mismatches
     * @returns ReconciliationMismatchListResponse Reconciliation mismatches
     * @throws ApiError
     */
    public static getReconciliationRunsMismatches({
        runId,
        field,
        resolution,
        iccid,
        enterpriseId,
        page = 1,
        pageSize = 20,
    }: {
        runId: string,
        field?: string,
        resolution?: string,
        iccid?: string,
        enterpriseId?: string,
        page?: number,
        pageSize?: number,
    }): CancelablePromise<ReconciliationMismatchListResponse> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/reconciliation/runs/{runId}/mismatches',
            path: {
                'runId': runId,
            },
            query: {
                'field': field,
                'resolution': resolution,
                'iccid': iccid,
                'enterpriseId': enterpriseId,
                'page': page,
                'pageSize': pageSize,
            },
            errors: {
                400: `Validation error`,
                401: `Unauthorized`,
                403: `Forbidden`,
                404: `Not found`,
            },
        });
    }
    /**
     * Get Reconciliation Mismatch Trace
     * @returns ReconciliationMismatchTraceResponse Reconciliation mismatch trace
     * @throws ApiError
     */
    public static getReconciliationRunsMismatchesTrace({
        runId,
        iccid,
    }: {
        runId: string,
        iccid: string,
    }): CancelablePromise<ReconciliationMismatchTraceResponse> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/reconciliation/runs/{runId}/mismatches/{iccid}/trace',
            path: {
                'runId': runId,
                'iccid': iccid,
            },
            errors: {
                400: `Validation error`,
                401: `Unauthorized`,
                403: `Forbidden`,
                404: `Not found`,
            },
        });
    }
}
