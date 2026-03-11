/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { Operator } from '../models/Operator';
import type { OperatorCreateRequest } from '../models/OperatorCreateRequest';
import type { OperatorListResponse } from '../models/OperatorListResponse';
import type { OperatorUpdateRequest } from '../models/OperatorUpdateRequest';
import type { Supplier } from '../models/Supplier';
import type { SupplierBindOperatorRequest } from '../models/SupplierBindOperatorRequest';
import type { SupplierBindOperatorResponse } from '../models/SupplierBindOperatorResponse';
import type { SupplierCreateRequest } from '../models/SupplierCreateRequest';
import type { SupplierListResponse } from '../models/SupplierListResponse';
import type { SupplierStatusChangeRequest } from '../models/SupplierStatusChangeRequest';
import type { SupplierStatusChangeResponse } from '../models/SupplierStatusChangeResponse';
import type { SupplierUpdateRequest } from '../models/SupplierUpdateRequest';
import type { SupplierUpdateResponse } from '../models/SupplierUpdateResponse';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class SuppliersService {
    /**
     * List Operators
     * Query operators by operatorId or MCC/MNC/name. Authentication required.
     * @returns OperatorListResponse Operator list
     * @throws ApiError
     */
    public static getOperators({
        operatorId,
        mcc,
        mnc,
        name,
        page = 1,
        pageSize = 20,
        limit,
    }: {
        operatorId?: string,
        mcc?: string,
        mnc?: string,
        name?: string,
        page?: number,
        pageSize?: number,
        limit?: number,
    }): CancelablePromise<OperatorListResponse> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/operators',
            query: {
                'operatorId': operatorId,
                'mcc': mcc,
                'mnc': mnc,
                'name': name,
                'page': page,
                'pageSize': pageSize,
                'limit': limit,
            },
            errors: {
                400: `Validation error`,
                401: `Unauthorized`,
            },
        });
    }
    /**
     * Create Operator
     * Create a mobile network operator (MCC/MNC). Platform admin only.
     * @returns Operator Operator created
     * @throws ApiError
     */
    public static postOperators({
        requestBody,
    }: {
        requestBody: OperatorCreateRequest,
    }): CancelablePromise<Operator> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/operators',
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Validation error`,
                401: `Unauthorized`,
                403: `Forbidden`,
                409: `Duplicate operator`,
            },
        });
    }
    /**
     * Update Operator
     * Update operator fields. Platform admin only.
     * @returns Operator Operator updated
     * @throws ApiError
     */
    public static patchOperators({
        operatorId,
        requestBody,
    }: {
        operatorId: string,
        requestBody: OperatorUpdateRequest,
    }): CancelablePromise<Operator> {
        return __request(OpenAPI, {
            method: 'PATCH',
            url: '/operators/{operatorId}',
            path: {
                'operatorId': operatorId,
            },
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Validation error`,
                401: `Unauthorized`,
                403: `Forbidden`,
                404: `Not found`,
            },
        });
    }
    /**
     * Create Supplier
     * @returns Supplier Supplier created
     * @throws ApiError
     */
    public static postSuppliers({
        requestBody,
    }: {
        requestBody: SupplierCreateRequest,
    }): CancelablePromise<Supplier> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/suppliers',
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Validation error`,
                403: `Forbidden`,
                409: `Duplicate supplier name`,
            },
        });
    }
    /**
     * List Suppliers
     * @returns SupplierListResponse Supplier list
     * @throws ApiError
     */
    public static getSuppliers({
        status,
        page = 1,
        pageSize = 20,
    }: {
        status?: 'ACTIVE' | 'SUSPENDED',
        page?: number,
        pageSize?: number,
    }): CancelablePromise<SupplierListResponse> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/suppliers',
            query: {
                'status': status,
                'page': page,
                'pageSize': pageSize,
            },
            errors: {
                400: `Validation error`,
                403: `Forbidden`,
            },
        });
    }
    /**
     * Get Supplier Detail
     * @returns Supplier Supplier detail
     * @throws ApiError
     */
    public static getSuppliers1({
        supplierId,
    }: {
        supplierId: string,
    }): CancelablePromise<Supplier> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/suppliers/{supplierId}',
            path: {
                'supplierId': supplierId,
            },
            errors: {
                400: `Validation error`,
                403: `Forbidden`,
                404: `Supplier not found`,
            },
        });
    }
    /**
     * Update Supplier
     * @returns SupplierUpdateResponse Supplier updated
     * @throws ApiError
     */
    public static patchSuppliers({
        supplierId,
        requestBody,
    }: {
        supplierId: string,
        requestBody: SupplierUpdateRequest,
    }): CancelablePromise<SupplierUpdateResponse> {
        return __request(OpenAPI, {
            method: 'PATCH',
            url: '/suppliers/{supplierId}',
            path: {
                'supplierId': supplierId,
            },
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Validation error`,
                403: `Forbidden`,
                404: `Supplier not found`,
                409: `Duplicate supplier name`,
            },
        });
    }
    /**
     * Change Supplier Status
     * @returns SupplierStatusChangeResponse Supplier status changed
     * @throws ApiError
     */
    public static postSuppliers-:changeStatus({
        supplierId,
        requestBody,
    }: {
        supplierId: string,
        requestBody: SupplierStatusChangeRequest,
    }): CancelablePromise<SupplierStatusChangeResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/suppliers/{supplierId}:change-status',
            path: {
                'supplierId': supplierId,
            },
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Validation error`,
                403: `Forbidden`,
                404: `Supplier not found`,
            },
        });
    }
    /**
     * Bind Operator to Supplier
     * @returns SupplierBindOperatorResponse Operator bound to supplier
     * @throws ApiError
     */
    public static postSuppliersOperators({
        supplierId,
        requestBody,
    }: {
        supplierId: string,
        requestBody: SupplierBindOperatorRequest,
    }): CancelablePromise<SupplierBindOperatorResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/suppliers/{supplierId}/operators',
            path: {
                'supplierId': supplierId,
            },
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Validation error`,
                403: `Forbidden`,
                404: `Supplier or operator not found`,
                409: `Operator already bound`,
            },
        });
    }
}
