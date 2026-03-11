/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { BalanceInfo } from '../models/BalanceInfo';
import type { SimBatchDeactivateAcceptedResponse } from '../models/SimBatchDeactivateAcceptedResponse';
import type { SimBatchDeactivateJobResponse } from '../models/SimBatchDeactivateJobResponse';
import type { SimBatchDeactivateRequest } from '../models/SimBatchDeactivateRequest';
import type { SimBatchStatusChangeRequest } from '../models/SimBatchStatusChangeRequest';
import type { SimBatchStatusChangeResponse } from '../models/SimBatchStatusChangeResponse';
import type { SimCard } from '../models/SimCard';
import type { SimCardListResponse } from '../models/SimCardListResponse';
import type { SimImportJobAcceptedResponse } from '../models/SimImportJobAcceptedResponse';
import type { SimPlanChange } from '../models/SimPlanChange';
import type { SimPlanChangeResponse } from '../models/SimPlanChangeResponse';
import type { SimStatusUpdate } from '../models/SimStatusUpdate';
import type { SimStatusUpdateResponse } from '../models/SimStatusUpdateResponse';
import type { SimSubscriptionListResponse } from '../models/SimSubscriptionListResponse';
import type { SimUsageRecordListResponse } from '../models/SimUsageRecordListResponse';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class SiMsService {
    /**
     * Search SIM Cards
     * Retrieve a list of SIM cards based on filters.
     * @returns SimCardListResponse List of SIM cards
     * @throws ApiError
     */
    public static getSims({
        enterpriseId,
        departmentId,
        resellerId,
        iccid,
        msisdn,
        status,
        supplierId,
        operatorId,
        page = 1,
        pageSize = 20,
        limit = 20,
    }: {
        /**
         * Optional enterprise filter
         */
        enterpriseId?: string,
        /**
         * Optional department filter (requires enterpriseId)
         */
        departmentId?: string,
        /**
         * Optional reseller filter (platform only)
         */
        resellerId?: string,
        /**
         * Filter by exact ICCID
         */
        iccid?: string,
        /**
         * Filter by MSISDN
         */
        msisdn?: string,
        /**
         * Filter by lifecycle status
         */
        status?: 'INVENTORY' | 'TEST_READY' | 'ACTIVATED' | 'DEACTIVATED' | 'RETIRED',
        /**
         * Filter by supplier
         */
        supplierId?: string,
        /**
         * Filter by operator UUID or business operator UUID
         */
        operatorId?: string,
        page?: number,
        /**
         * Alias of limit, preferred
         */
        pageSize?: number,
        limit?: number,
    }): CancelablePromise<SimCardListResponse> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/sims',
            query: {
                'enterpriseId': enterpriseId,
                'departmentId': departmentId,
                'resellerId': resellerId,
                'iccid': iccid,
                'msisdn': msisdn,
                'status': status,
                'supplierId': supplierId,
                'operatorId': operatorId,
                'page': page,
                'pageSize': pageSize,
                'limit': limit,
            },
        });
    }
    /**
     * Export SIM Cards CSV
     * Exports SIM list as CSV with applied filters.
     * @returns string CSV file of SIM cards
     * @throws ApiError
     */
    public static simsCsv({
        enterpriseId,
        departmentId,
        resellerId,
        iccid,
        msisdn,
        status,
        supplierId,
        operatorId,
        page = 1,
        pageSize = 1000,
        limit = 1000,
    }: {
        /**
         * Optional enterprise filter
         */
        enterpriseId?: string,
        /**
         * Optional department filter (requires enterpriseId)
         */
        departmentId?: string,
        /**
         * Optional reseller filter (platform only)
         */
        resellerId?: string,
        /**
         * Filter by exact ICCID
         */
        iccid?: string,
        /**
         * Filter by MSISDN
         */
        msisdn?: string,
        /**
         * Filter by lifecycle status
         */
        status?: 'INVENTORY' | 'TEST_READY' | 'ACTIVATED' | 'DEACTIVATED' | 'RETIRED',
        /**
         * Filter by supplier
         */
        supplierId?: string,
        /**
         * Filter by operator UUID or business operator UUID
         */
        operatorId?: string,
        page?: number,
        /**
         * Alias of limit, preferred
         */
        pageSize?: number,
        limit?: number,
    }): CancelablePromise<string> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/sims:csv',
            query: {
                'enterpriseId': enterpriseId,
                'departmentId': departmentId,
                'resellerId': resellerId,
                'iccid': iccid,
                'msisdn': msisdn,
                'status': status,
                'supplierId': supplierId,
                'operatorId': operatorId,
                'page': page,
                'pageSize': pageSize,
                'limit': limit,
            },
            errors: {
                401: `Unauthorized`,
            },
        });
    }
    /**
     * Export Enterprise SIM Cards CSV
     * Exports SIM list for a specific enterprise as CSV with applied filters.
     * @returns string CSV file of SIM cards
     * @throws ApiError
     */
    public static enterpriseSimsCsv({
        enterpriseId,
        departmentId,
        iccid,
        msisdn,
        status,
        limit = 1000,
        page = 1,
    }: {
        enterpriseId: string,
        /**
         * Optional department filter within the enterprise
         */
        departmentId?: string,
        /**
         * Filter by exact ICCID
         */
        iccid?: string,
        /**
         * Filter by MSISDN
         */
        msisdn?: string,
        /**
         * Filter by lifecycle status
         */
        status?: 'INVENTORY' | 'TEST_READY' | 'ACTIVATED' | 'DEACTIVATED' | 'RETIRED',
        limit?: number,
        page?: number,
    }): CancelablePromise<string> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/enterprises/{enterpriseId}/sims:csv',
            path: {
                'enterpriseId': enterpriseId,
            },
            query: {
                'departmentId': departmentId,
                'iccid': iccid,
                'msisdn': msisdn,
                'status': status,
                'limit': limit,
                'page': page,
            },
            errors: {
                401: `Unauthorized`,
            },
        });
    }
    /**
     * Import SIMs from CSV
     * Upload a CSV file to create SIMs in bulk as an async job. Allowed roles are platform_admin and reseller_admin.
     * @returns SimImportJobAcceptedResponse Import job accepted
     * @throws ApiError
     */
    public static postSimsImportJobs({
        formData,
    }: {
        formData: {
            resellerId: string;
            supplierId: string;
            operatorId: string;
            apn: string;
            batchId?: string | null;
            /**
             * CSV file. Required columns: iccid, imsi. Optional columns: msisdn, secondaryImsi1, secondaryImsi2, secondaryImsi3, formFactor, activationCode, imei, imeiLockEnabled. See example below.
             */
            file: Blob;
        },
    }): CancelablePromise<SimImportJobAcceptedResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/sims/import-jobs',
            formData: formData,
            mediaType: 'multipart/form-data',
            errors: {
                400: `Invalid request`,
                401: `Unauthorized`,
            },
        });
    }
    /**
     * Batch Deactivate SIMs
     * Deactivates all active SIMs under the specified enterprise.
     * @returns SimBatchDeactivateJobResponse Idempotent job returned
     * @returns SimBatchDeactivateAcceptedResponse Batch deactivation job accepted
     * @throws ApiError
     */
    public static postSims:batchDeactivate({
        requestBody,
    }: {
        requestBody: SimBatchDeactivateRequest,
    }): CancelablePromise<SimBatchDeactivateJobResponse | SimBatchDeactivateAcceptedResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/sims:batch-deactivate',
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Invalid request`,
                401: `Unauthorized`,
                403: `Forbidden`,
                404: `Resource not found`,
            },
        });
    }
    /**
     * Batch Change SIM Status
     * Batch update SIM status with per-SIM results.
     * @returns SimBatchStatusChangeResponse All SIMs processed successfully
     * @throws ApiError
     */
    public static postSims:batchStatusChange({
        requestBody,
    }: {
        requestBody: SimBatchStatusChangeRequest,
    }): CancelablePromise<SimBatchStatusChangeResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/sims:batch-status-change',
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Invalid request or all SIMs failed`,
                401: `Unauthorized`,
                403: `Forbidden`,
            },
        });
    }
    /**
     * Get SIM Details
     * @returns SimCard Detailed SIM information
     * @throws ApiError
     */
    public static getSims1({
        iccid,
    }: {
        iccid: string,
    }): CancelablePromise<SimCard> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/sims/{iccid}',
            path: {
                'iccid': iccid,
            },
            errors: {
                404: `SIM not found`,
            },
        });
    }
    /**
     * Change SIM Status
     * Activate or Deactivate a SIM card.
     * @returns SimStatusUpdateResponse Status update initiated successfully
     * @throws ApiError
     */
    public static patchSims({
        iccid,
        requestBody,
    }: {
        iccid: string,
        requestBody: SimStatusUpdate,
    }): CancelablePromise<SimStatusUpdateResponse> {
        return __request(OpenAPI, {
            method: 'PATCH',
            url: '/sims/{iccid}',
            path: {
                'iccid': iccid,
            },
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Invalid status transition`,
            },
        });
    }
    /**
     * Change Rate Plan
     * @returns SimPlanChangeResponse Plan change scheduled
     * @throws ApiError
     */
    public static putSimsPlan({
        iccid,
        requestBody,
    }: {
        iccid: string,
        requestBody: SimPlanChange,
    }): CancelablePromise<SimPlanChangeResponse> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/sims/{iccid}/plan',
            path: {
                'iccid': iccid,
            },
            body: requestBody,
            mediaType: 'application/json',
        });
    }
    /**
     * List SIM Subscriptions
     * @returns SimSubscriptionListResponse Subscriptions bound to the SIM
     * @throws ApiError
     */
    public static getSimsSubscriptions({
        iccid,
    }: {
        iccid: string,
    }): CancelablePromise<SimSubscriptionListResponse> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/sims/{iccid}/subscriptions',
            path: {
                'iccid': iccid,
            },
            errors: {
                401: `Unauthorized`,
                404: `SIM not found`,
            },
        });
    }
    /**
     * Get Data Usage History
     * @returns SimUsageRecordListResponse Usage records
     * @throws ApiError
     */
    public static getSimsUsage({
        iccid,
        startDate,
        endDate,
    }: {
        iccid: string,
        startDate: string,
        endDate: string,
    }): CancelablePromise<SimUsageRecordListResponse> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/sims/{iccid}/usage',
            path: {
                'iccid': iccid,
            },
            query: {
                'startDate': startDate,
                'endDate': endDate,
            },
        });
    }
    /**
     * Get Real-time Balance
     * @returns BalanceInfo Current balance and quotas
     * @throws ApiError
     */
    public static getSimsBalance({
        iccid,
    }: {
        iccid: string,
    }): CancelablePromise<BalanceInfo> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/sims/{iccid}/balance',
            path: {
                'iccid': iccid,
            },
        });
    }
}
