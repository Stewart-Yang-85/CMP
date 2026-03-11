/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { EventListResponse } from '../models/EventListResponse';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class EventsService {
    /**
     * List Events
     * @returns EventListResponse Event list
     * @throws ApiError
     */
    public static listEvents({
        enterpriseId,
        resellerId,
        eventType,
        from,
        to,
        simId,
        page = 1,
        pageSize = 20,
    }: {
        enterpriseId?: string,
        resellerId?: string,
        eventType?: string,
        from?: string,
        to?: string,
        simId?: string,
        page?: number,
        pageSize?: number,
    }): CancelablePromise<EventListResponse> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/events',
            query: {
                'enterpriseId': enterpriseId,
                'resellerId': resellerId,
                'eventType': eventType,
                'from': from,
                'to': to,
                'simId': simId,
                'page': page,
                'pageSize': pageSize,
            },
            errors: {
                400: `Invalid request`,
                401: `Unauthorized`,
                403: `Forbidden`,
            },
        });
    }
}
