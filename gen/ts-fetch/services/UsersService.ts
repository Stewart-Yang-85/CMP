/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { EnterpriseUserAssignDepartmentsRequest } from '../models/EnterpriseUserAssignDepartmentsRequest';
import type { EnterpriseUserAssignDepartmentsResponse } from '../models/EnterpriseUserAssignDepartmentsResponse';
import type { EnterpriseUserCreateRequest } from '../models/EnterpriseUserCreateRequest';
import type { ResellerUserAssignEnterprisesRequest } from '../models/ResellerUserAssignEnterprisesRequest';
import type { ResellerUserAssignEnterprisesResponse } from '../models/ResellerUserAssignEnterprisesResponse';
import type { ResellerUserCreateRequest } from '../models/ResellerUserCreateRequest';
import type { TenantUser } from '../models/TenantUser';
import type { TenantUserListResponse } from '../models/TenantUserListResponse';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class UsersService {
    /**
     * Assign Reseller User Enterprises
     * @returns ResellerUserAssignEnterprisesResponse Reseller user enterprises assigned
     * @throws ApiError
     */
    public static postResellersUsersAssignEnterprises({
        resellerId,
        userId,
        requestBody,
    }: {
        resellerId: string,
        userId: string,
        requestBody: ResellerUserAssignEnterprisesRequest,
    }): CancelablePromise<ResellerUserAssignEnterprisesResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/resellers/{resellerId}/users/{userId}/assign-enterprises',
            path: {
                'resellerId': resellerId,
                'userId': userId,
            },
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Validation error`,
                401: `Unauthorized`,
                403: `Forbidden`,
                404: `Reseller or user not found`,
            },
        });
    }
    /**
     * Assign Enterprise User Departments
     * @returns EnterpriseUserAssignDepartmentsResponse Enterprise user departments assigned
     * @throws ApiError
     */
    public static postEnterprisesUsersAssignDepartments({
        enterpriseId,
        userId,
        requestBody,
    }: {
        enterpriseId: string,
        userId: string,
        requestBody: EnterpriseUserAssignDepartmentsRequest,
    }): CancelablePromise<EnterpriseUserAssignDepartmentsResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/enterprises/{enterpriseId}/users/{userId}/assign-departments',
            path: {
                'enterpriseId': enterpriseId,
                'userId': userId,
            },
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Validation error`,
                401: `Unauthorized`,
                403: `Forbidden`,
                404: `Enterprise or user not found`,
            },
        });
    }
    /**
     * Create Reseller User
     * @returns TenantUser Reseller user created
     * @throws ApiError
     */
    public static postResellersUsers({
        resellerId,
        requestBody,
    }: {
        resellerId: string,
        requestBody: ResellerUserCreateRequest,
    }): CancelablePromise<TenantUser> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/resellers/{resellerId}/users',
            path: {
                'resellerId': resellerId,
            },
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Validation error`,
                401: `Unauthorized`,
                403: `Forbidden`,
                404: `Reseller not found`,
            },
        });
    }
    /**
     * List Reseller Users
     * @returns TenantUserListResponse Reseller user list
     * @throws ApiError
     */
    public static getResellersUsers({
        resellerId,
        page = 1,
        pageSize = 20,
    }: {
        resellerId: string,
        page?: number,
        pageSize?: number,
    }): CancelablePromise<TenantUserListResponse> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/resellers/{resellerId}/users',
            path: {
                'resellerId': resellerId,
            },
            query: {
                'page': page,
                'pageSize': pageSize,
            },
            errors: {
                400: `Validation error`,
                401: `Unauthorized`,
                403: `Forbidden`,
            },
        });
    }
    /**
     * List Enterprise Users
     * @returns TenantUserListResponse Enterprise user list
     * @throws ApiError
     */
    public static getEnterprisesUsers({
        enterpriseId,
        page = 1,
        pageSize = 20,
    }: {
        enterpriseId: string,
        page?: number,
        pageSize?: number,
    }): CancelablePromise<TenantUserListResponse> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/enterprises/{enterpriseId}/users',
            path: {
                'enterpriseId': enterpriseId,
            },
            query: {
                'page': page,
                'pageSize': pageSize,
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
     * Create Enterprise User
     * @returns TenantUser Enterprise user created
     * @throws ApiError
     */
    public static postEnterprisesUsers({
        enterpriseId,
        requestBody,
    }: {
        enterpriseId: string,
        requestBody: EnterpriseUserCreateRequest,
    }): CancelablePromise<TenantUser> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/enterprises/{enterpriseId}/users',
            path: {
                'enterpriseId': enterpriseId,
            },
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Validation error`,
                401: `Unauthorized`,
                403: `Forbidden`,
                404: `Enterprise not found`,
            },
        });
    }
}
