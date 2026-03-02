/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { Bill } from '../models/Bill';
import type { BillList } from '../models/BillList';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class BillingService {
    /**
     * List Bills
     * @returns BillList Bills
     * @throws ApiError
     */
    public static getBills({
        period,
        status,
        sortBy,
        sortOrder = 'desc',
    }: {
        period?: string,
        status?: 'GENERATED' | 'PUBLISHED' | 'PAID' | 'OVERDUE' | 'WRITTEN_OFF',
        sortBy?: 'period' | 'dueDate' | 'totalAmount' | 'status',
        sortOrder?: 'asc' | 'desc',
    }): CancelablePromise<BillList> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/bills',
            query: {
                'period': period,
                'status': status,
                'sortBy': sortBy,
                'sortOrder': sortOrder,
            },
        });
    }
    /**
     * Export Bills CSV
     * Exports bills accessible to the calling enterprise as CSV.
     * @returns string CSV file of bills
     * @throws ApiError
     */
    public static billsCsv({
        period,
        status,
        sortBy,
        sortOrder,
        limit = 1000,
        page = 1,
    }: {
        /**
         * Filter by billing period (YYYY-MM)
         */
        period?: string,
        /**
         * Filter by bill status
         */
        status?: 'GENERATED' | 'PUBLISHED' | 'PAID' | 'OVERDUE' | 'WRITTEN_OFF',
        /**
         * Sort field
         */
        sortBy?: 'period' | 'dueDate' | 'totalAmount' | 'status',
        /**
         * Sort direction
         */
        sortOrder?: 'asc' | 'desc',
        limit?: number,
        page?: number,
    }): CancelablePromise<string> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/bills:csv',
            query: {
                'period': period,
                'status': status,
                'sortBy': sortBy,
                'sortOrder': sortOrder,
                'limit': limit,
                'page': page,
            },
        });
    }
    /**
     * Get Bill Details
     * @returns Bill Bill
     * @throws ApiError
     */
    public static getBills1({
        billId,
    }: {
        billId: string,
    }): CancelablePromise<Bill> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/bills/{billId}',
            path: {
                'billId': billId,
            },
        });
    }
    /**
     * Download Bill Files
     * @returns any File URLs
     * @throws ApiError
     */
    public static getBillsFiles({
        billId,
    }: {
        billId: string,
    }): CancelablePromise<{
        pdfUrl?: string | null;
        csvUrl?: string;
    }> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/bills/{billId}/files',
            path: {
                'billId': billId,
            },
        });
    }
    /**
     * Download Bill CSV
     * Returns a CSV export of bill line items.
     * @returns string CSV content
     * @throws ApiError
     */
    public static billFileCsv({
        billId,
    }: {
        billId: string,
    }): CancelablePromise<string> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/bills/{billId}/files/csv',
            path: {
                'billId': billId,
            },
        });
    }
}
