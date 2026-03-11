/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ConnectionStatus } from '../models/ConnectionStatus';
import type { ReadyResponse } from '../models/ReadyResponse';
import type { ResetConnectionResponse } from '../models/ResetConnectionResponse';
import type { SimLocation } from '../models/SimLocation';
import type { SimLocationHistoryResponse } from '../models/SimLocationHistoryResponse';
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
     * @returns ResetConnectionResponse Reset command accepted
     * @throws ApiError
     */
    public static postSims-:resetConnection({
        iccid,
    }: {
        iccid: string,
    }): CancelablePromise<ResetConnectionResponse> {
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
     * @returns SimLocation Current location (if supported by supplier)
     * @throws ApiError
     */
    public static getSimsLocation({
        iccid,
    }: {
        iccid: string,
    }): CancelablePromise<SimLocation> {
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
     * @returns SimLocationHistoryResponse Location history
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
    }): CancelablePromise<SimLocationHistoryResponse> {
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
     * @returns ReadyResponse Service is ready
     * @throws ApiError
     */
    public static getReady(): CancelablePromise<ReadyResponse> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/ready',
            errors: {
                503: `Service is not ready`,
            },
        });
    }
}
