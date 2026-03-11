/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { Enterprise } from '../models/Enterprise';
import type { EnterpriseCreateRequest } from '../models/EnterpriseCreateRequest';
import type { EnterpriseListResponse } from '../models/EnterpriseListResponse';
import type { EnterpriseStatusChangeRequest } from '../models/EnterpriseStatusChangeRequest';
import type { EnterpriseStatusChangeResponse } from '../models/EnterpriseStatusChangeResponse';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class EnterprisesService {
    /**
     * Create Enterprise
     * @returns Enterprise Enterprise created
     * @throws ApiError
     */
    public static postEnterprises({
        requestBody,
    }: {
        requestBody: EnterpriseCreateRequest,
    }): CancelablePromise<Enterprise> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/enterprises',
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Validation error`,
                403: `Forbidden`,
                404: `Reseller not found`,
            },
        });
    }
    /**
     * List Enterprises
     * @returns EnterpriseListResponse Enterprise list
     * @throws ApiError
     */
    public static getEnterprises({
        page = 1,
        pageSize = 20,
        status,
        resellerId,
    }: {
        page?: number,
        pageSize?: number,
        status?: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED',
        resellerId?: string,
    }): CancelablePromise<EnterpriseListResponse> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/enterprises',
            query: {
                'page': page,
                'pageSize': pageSize,
                'status': status,
                'resellerId': resellerId,
            },
            errors: {
                400: `Validation error`,
                403: `Forbidden`,
            },
        });
    }
    /**
     * Get Enterprise Detail
     * @returns Enterprise Enterprise detail
     * @throws ApiError
     */
    public static getEnterprises1({
        enterpriseId,
    }: {
        enterpriseId: string,
    }): CancelablePromise<Enterprise> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/enterprises/{enterpriseId}',
            path: {
                'enterpriseId': enterpriseId,
            },
            errors: {
                400: `Validation error`,
                401: `Unauthorized`,
                403: `Forbidden`,
                404: `Enterprise not found`,
            },
        });
    }
    /**
     * Change Enterprise Status
     * @returns EnterpriseStatusChangeResponse Enterprise status changed
     * @throws ApiError
     */
    public static postEnterprises-:changeStatus({
        enterpriseId,
        requestBody,
    }: {
        enterpriseId: string,
        requestBody: EnterpriseStatusChangeRequest,
    }): CancelablePromise<EnterpriseStatusChangeResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/enterprises/{enterpriseId}:change-status',
            path: {
                'enterpriseId': enterpriseId,
            },
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Validation error`,
                403: `Forbidden`,
                404: `Enterprise not found`,
            },
        });
    }
}
