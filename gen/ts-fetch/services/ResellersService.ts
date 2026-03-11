/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { Reseller } from '../models/Reseller';
import type { ResellerBindSupplierRequest } from '../models/ResellerBindSupplierRequest';
import type { ResellerBindSupplierResponse } from '../models/ResellerBindSupplierResponse';
import type { ResellerCreateRequest } from '../models/ResellerCreateRequest';
import type { ResellerListResponse } from '../models/ResellerListResponse';
import type { ResellerStatusChangeRequest } from '../models/ResellerStatusChangeRequest';
import type { ResellerStatusChangeResponse } from '../models/ResellerStatusChangeResponse';
import type { ResellerSuppliersListResponse } from '../models/ResellerSuppliersListResponse';
import type { ResellerUpdateRequest } from '../models/ResellerUpdateRequest';
import type { ResellerUpdateResponse } from '../models/ResellerUpdateResponse';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class ResellersService {
    /**
     * Create Reseller
     * @returns Reseller Reseller created
     * @throws ApiError
     */
    public static postResellers({
        requestBody,
    }: {
        requestBody: ResellerCreateRequest,
    }): CancelablePromise<Reseller> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/resellers',
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Validation error`,
                403: `Forbidden`,
                409: `Duplicate reseller name`,
            },
        });
    }
    /**
     * List Resellers
     * @returns ResellerListResponse Reseller list
     * @throws ApiError
     */
    public static getResellers({
        page = 1,
        pageSize = 20,
        status,
    }: {
        page?: number,
        pageSize?: number,
        status?: 'ACTIVE' | 'DEACTIVATED' | 'SUSPENDED',
    }): CancelablePromise<ResellerListResponse> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/resellers',
            query: {
                'page': page,
                'pageSize': pageSize,
                'status': status,
            },
            errors: {
                400: `Validation error`,
                403: `Forbidden`,
            },
        });
    }
    /**
     * Get Reseller Detail
     * @returns Reseller Reseller detail
     * @throws ApiError
     */
    public static getResellers1({
        resellerId,
    }: {
        resellerId: string,
    }): CancelablePromise<Reseller> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/resellers/{resellerId}',
            path: {
                'resellerId': resellerId,
            },
            errors: {
                401: `Unauthorized`,
                403: `Forbidden`,
                404: `Reseller not found`,
            },
        });
    }
    /**
     * Update Reseller
     * @returns ResellerUpdateResponse Reseller updated
     * @throws ApiError
     */
    public static patchResellersUsersAssignEnterprises({
        resellerId,
        requestBody,
    }: {
        resellerId: string,
        requestBody: ResellerUpdateRequest,
    }): CancelablePromise<ResellerUpdateResponse> {
        return __request(OpenAPI, {
            method: 'PATCH',
            url: '/resellers/{resellerId}/users/{userId}/assign-enterprises',
            path: {
                'resellerId': resellerId,
            },
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Validation error`,
                403: `Forbidden`,
                404: `Reseller not found`,
                409: `Duplicate reseller name`,
            },
        });
    }
    /**
     * Change Reseller Status
     * @returns ResellerStatusChangeResponse Reseller status changed
     * @throws ApiError
     */
    public static postResellers-:changeStatus({
        resellerId,
        requestBody,
    }: {
        resellerId: string,
        requestBody: ResellerStatusChangeRequest,
    }): CancelablePromise<ResellerStatusChangeResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/resellers/{resellerId}:change-status',
            path: {
                'resellerId': resellerId,
            },
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
     * Bind Supplier to Reseller
     * @returns ResellerBindSupplierResponse Supplier bound to reseller
     * @throws ApiError
     */
    public static postResellersSuppliers({
        resellerId,
        requestBody,
    }: {
        resellerId: string,
        requestBody: ResellerBindSupplierRequest,
    }): CancelablePromise<ResellerBindSupplierResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/resellers/{resellerId}/suppliers',
            path: {
                'resellerId': resellerId,
            },
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Validation error`,
                403: `Forbidden`,
                404: `Reseller or supplier not found`,
                409: `Supplier already bound`,
            },
        });
    }
    /**
     * List Reseller Suppliers
     * @returns ResellerSuppliersListResponse Reseller suppliers
     * @throws ApiError
     */
    public static getResellersSuppliers({
        resellerId,
    }: {
        resellerId: string,
    }): CancelablePromise<ResellerSuppliersListResponse> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/resellers/{resellerId}/suppliers',
            path: {
                'resellerId': resellerId,
            },
            errors: {
                400: `Validation error`,
                403: `Forbidden`,
                404: `Reseller not found`,
            },
        });
    }
}
