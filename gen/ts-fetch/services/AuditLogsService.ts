/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { AdminAuditLogListResponse } from '../models/AdminAuditLogListResponse';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class AuditLogsService {
    /**
     * List Audit Logs
     * @returns AdminAuditLogListResponse Audit log list
     * @throws ApiError
     */
    public static getAuditLogs({
        actor,
        action,
        from,
        to,
        resellerId,
        page = 1,
        pageSize = 20,
    }: {
        actor?: string,
        action?: string,
        from?: string,
        to?: string,
        resellerId?: string,
        page?: number,
        pageSize?: number,
    }): CancelablePromise<AdminAuditLogListResponse> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/audit-logs',
            query: {
                'actor': actor,
                'action': action,
                'from': from,
                'to': to,
                'resellerId': resellerId,
                'page': page,
                'pageSize': pageSize,
            },
            errors: {
                401: `Unauthorized`,
                403: `Forbidden`,
            },
        });
    }
}
