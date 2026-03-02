/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ConnectionStatus } from '../models/ConnectionStatus';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class DiagnosticsService {
    /**
     * Get Connectivity Status
     * Connectivity status based on upstream CMP API capabilities.
     * @returns ConnectionStatus Connectivity status
     * @throws ApiError
     */
    public static getSimsConnectivityStatus({
        iccid,
    }: {
        iccid: string,
    }): CancelablePromise<ConnectionStatus> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/sims/{iccid}/connectivity-status',
            path: {
                'iccid': iccid,
            },
        });
    }
    /**
     * Reset Network Connection
     * Requests upstream CMP to reset connectivity (if supported).
     * @returns any Reset command accepted
     * @throws ApiError
     */
    public static postSims-:resetConnection({
        iccid,
    }: {
        iccid: string,
    }): CancelablePromise<{
        success?: boolean;
        message?: string;
    }> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/sims/{iccid}:reset-connection',
            path: {
                'iccid': iccid,
            },
        });
    }
    /**
     * Get Current Location
     * @returns any Current location (if supported by supplier)
     * @throws ApiError
     */
    public static getSimsLocation({
        iccid,
    }: {
        iccid: string,
    }): CancelablePromise<{
        visitedMccMnc?: string;
        country?: string;
        updatedAt?: string;
    }> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/sims/{iccid}/location',
            path: {
                'iccid': iccid,
            },
        });
    }
    /**
     * Get Location History
     * @returns any Location history
     * @throws ApiError
     */
    public static getSimsLocationHistory({
        iccid,
        startDate,
        endDate,
    }: {
        iccid: string,
        startDate: string,
        endDate: string,
    }): CancelablePromise<Array<{
        visitedMccMnc?: string;
        occurredAt?: string;
    }>> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/sims/{iccid}/location-history',
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
     * Readiness Probe
     * Returns readiness of the service, including upstream Supabase connectivity if configured.
     * @returns any Service is ready
     * @throws ApiError
     */
    public static getReady(): CancelablePromise<{
        ok?: boolean;
        details?: Record<string, any>;
    }> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/ready',
            errors: {
                503: `Service is not ready`,
            },
        });
    }
}
