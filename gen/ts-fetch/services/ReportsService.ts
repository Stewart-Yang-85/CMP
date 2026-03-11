/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { AnomalySimsReport } from '../models/AnomalySimsReport';
import type { DeactivationReasonsReport } from '../models/DeactivationReasonsReport';
import type { TopSimsReport } from '../models/TopSimsReport';
import type { UsageTrendReport } from '../models/UsageTrendReport';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class ReportsService {
    /**
     * Usage Trend Report
     * @returns UsageTrendReport Usage trend report
     * @throws ApiError
     */
    public static reportsUsageTrend({
        period,
        enterpriseId,
        granularity,
    }: {
        period: string,
        enterpriseId?: string,
        granularity?: 'day' | 'month',
    }): CancelablePromise<UsageTrendReport> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/reports/usage-trend',
            query: {
                'enterpriseId': enterpriseId,
                'period': period,
                'granularity': granularity,
            },
            errors: {
                400: `Invalid request`,
                401: `Unauthorized`,
            },
        });
    }
    /**
     * Top SIMs Report
     * @returns TopSimsReport Top SIMs report
     * @throws ApiError
     */
    public static reportsTopSims({
        period,
        enterpriseId,
        limit = 10,
    }: {
        period: string,
        enterpriseId?: string,
        limit?: number,
    }): CancelablePromise<TopSimsReport> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/reports/top-sims',
            query: {
                'enterpriseId': enterpriseId,
                'period': period,
                'limit': limit,
            },
            errors: {
                400: `Invalid request`,
                401: `Unauthorized`,
            },
        });
    }
    /**
     * Anomaly SIMs Report
     * @returns AnomalySimsReport Anomaly SIMs report
     * @throws ApiError
     */
    public static reportsAnomalySims({
        period,
        enterpriseId,
    }: {
        period: string,
        enterpriseId?: string,
    }): CancelablePromise<AnomalySimsReport> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/reports/anomaly-sims',
            query: {
                'enterpriseId': enterpriseId,
                'period': period,
            },
            errors: {
                400: `Invalid request`,
                401: `Unauthorized`,
            },
        });
    }
    /**
     * Deactivation Reasons Report
     * @returns DeactivationReasonsReport Deactivation reasons report
     * @throws ApiError
     */
    public static reportsDeactivationReasons({
        period,
        enterpriseId,
    }: {
        period: string,
        enterpriseId?: string,
    }): CancelablePromise<DeactivationReasonsReport> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/reports/deactivation-reasons',
            query: {
                'enterpriseId': enterpriseId,
                'period': period,
            },
            errors: {
                400: `Invalid request`,
                401: `Unauthorized`,
            },
        });
    }
}
