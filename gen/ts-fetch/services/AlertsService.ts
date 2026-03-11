/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { Alert } from '../models/Alert';
import type { AlertsListResponse } from '../models/AlertsListResponse';
import type { AlertSummary } from '../models/AlertSummary';
import type { AlertTrend } from '../models/AlertTrend';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class AlertsService {
    /**
     * List Alerts
     * @returns AlertsListResponse Alerts list
     * @throws ApiError
     */
    public static listAlerts({
        enterpriseId,
        alertType,
        from,
        to,
        acknowledged,
        page = 1,
        limit = 50,
    }: {
        enterpriseId?: string,
        alertType?: string,
        from?: string,
        to?: string,
        acknowledged?: boolean,
        page?: number,
        limit?: number,
    }): CancelablePromise<AlertsListResponse> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/alerts',
            query: {
                'enterpriseId': enterpriseId,
                'alertType': alertType,
                'from': from,
                'to': to,
                'acknowledged': acknowledged,
                'page': page,
                'limit': limit,
            },
            errors: {
                401: `Unauthorized`,
            },
        });
    }
    /**
     * Acknowledge Alert
     * @returns Alert Alert acknowledged
     * @throws ApiError
     */
    public static acknowledgeAlert({
        alertId,
    }: {
        alertId: string,
    }): CancelablePromise<Alert> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/alerts/{alertId}:acknowledge',
            path: {
                'alertId': alertId,
            },
            errors: {
                404: `Alert not found`,
            },
        });
    }
    /**
     * Alert Summary
     * @returns AlertSummary Alert summary
     * @throws ApiError
     */
    public static alertsSummary({
        from,
        to,
        severity,
        alertType,
    }: {
        from?: string,
        to?: string,
        severity?: 'P0' | 'P1' | 'P2' | 'P3',
        alertType?: string,
    }): CancelablePromise<AlertSummary> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/alerts/summary',
            query: {
                'from': from,
                'to': to,
                'severity': severity,
                'alertType': alertType,
            },
        });
    }
    /**
     * Alert Trends
     * @returns AlertTrend Alert trends
     * @throws ApiError
     */
    public static alertsTrends({
        from,
        to,
        bucket,
        alertType,
    }: {
        from?: string,
        to?: string,
        bucket?: 'hour' | 'day',
        alertType?: string,
    }): CancelablePromise<AlertTrend> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/alerts/trends',
            query: {
                'from': from,
                'to': to,
                'bucket': bucket,
                'alertType': alertType,
            },
        });
    }
}
