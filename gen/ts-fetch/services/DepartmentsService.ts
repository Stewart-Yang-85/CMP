/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { Department } from '../models/Department';
import type { DepartmentCreateRequest } from '../models/DepartmentCreateRequest';
import type { DepartmentListResponse } from '../models/DepartmentListResponse';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class DepartmentsService {
    /**
     * Create Department
     * @returns Department Department created
     * @throws ApiError
     */
    public static postEnterprisesDepartments({
        enterpriseId,
        requestBody,
    }: {
        enterpriseId: string,
        requestBody: DepartmentCreateRequest,
    }): CancelablePromise<Department> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/enterprises/{enterpriseId}/departments',
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
    /**
     * List Departments
     * @returns DepartmentListResponse Department list
     * @throws ApiError
     */
    public static getEnterprisesDepartments({
        enterpriseId,
        page = 1,
        pageSize = 20,
    }: {
        enterpriseId: string,
        page?: number,
        pageSize?: number,
    }): CancelablePromise<DepartmentListResponse> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/enterprises/{enterpriseId}/departments',
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
     * Get Department Detail
     * @returns Department Department detail
     * @throws ApiError
     */
    public static getDepartments({
        departmentId,
    }: {
        departmentId: string,
    }): CancelablePromise<Department> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/departments/{departmentId}',
            path: {
                'departmentId': departmentId,
            },
            errors: {
                400: `Validation error`,
                401: `Unauthorized`,
                403: `Forbidden`,
                404: `Department not found`,
            },
        });
    }
}
