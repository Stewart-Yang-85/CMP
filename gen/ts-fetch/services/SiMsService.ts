/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { BalanceInfo } from '../models/BalanceInfo';
import type { DataUsageRecord } from '../models/DataUsageRecord';
import type { SimCard } from '../models/SimCard';
import type { SimPlanChange } from '../models/SimPlanChange';
import type { SimStatusUpdate } from '../models/SimStatusUpdate';
import type { Subscription } from '../models/Subscription';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class SiMsService {
    /**
     * Search SIM Cards
     * Retrieve a list of SIM cards based on filters.
     * @returns any List of SIM cards
     * @throws ApiError
     */
    public static getSims({
        iccid,
        msisdn,
        status,
        page = 1,
        limit = 20,
    }: {
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
        page?: number,
        limit?: number,
    }): CancelablePromise<{
        items?: Array<SimCard>;
        total?: number;
    }> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/sims',
            query: {
                'iccid': iccid,
                'msisdn': msisdn,
                'status': status,
                'page': page,
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
        iccid,
        msisdn,
        status,
        limit = 1000,
        page = 1,
    }: {
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
            url: '/sims:csv',
            query: {
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
     * @returns any Status update initiated successfully
     * @throws ApiError
     */
    public static patchSims({
        iccid,
        requestBody,
    }: {
        iccid: string,
        requestBody: SimStatusUpdate,
    }): CancelablePromise<{
        /**
         * ID for tracking the asynchronous operation
         */
        jobId?: string;
        status?: string;
    }> {
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
     * @returns any Plan change scheduled
     * @throws ApiError
     */
    public static putSimsPlan({
        iccid,
        requestBody,
    }: {
        iccid: string,
        requestBody: SimPlanChange,
    }): CancelablePromise<{
        success?: boolean;
        effectiveDate?: string;
    }> {
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
     * @returns Subscription Subscriptions bound to the SIM
     * @throws ApiError
     */
    public static getSimsSubscriptions({
        iccid,
    }: {
        iccid: string,
    }): CancelablePromise<Array<Subscription>> {
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
     * @returns DataUsageRecord Usage records
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
    }): CancelablePromise<Array<DataUsageRecord>> {
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
