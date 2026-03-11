/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { PricePlanCreateRequest } from '../models/PricePlanCreateRequest';
import type { PricePlanCreateResponse } from '../models/PricePlanCreateResponse';
import type { PricePlanDetailResponse } from '../models/PricePlanDetailResponse';
import type { PricePlanListResponse } from '../models/PricePlanListResponse';
import type { PricePlanVersionCreateRequest } from '../models/PricePlanVersionCreateRequest';
import type { PricePlanVersionCreateResponse } from '../models/PricePlanVersionCreateResponse';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class PricePlansService {
    /**
     * Create Price Plan
     * @returns PricePlanCreateResponse Price plan created
     * @throws ApiError
     */
    public static postEnterprisesPricePlans({
        enterpriseId,
        requestBody,
    }: {
        enterpriseId: string,
        requestBody: PricePlanCreateRequest,
    }): CancelablePromise<PricePlanCreateResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/enterprises/{enterpriseId}/price-plans',
            path: {
                'enterpriseId': enterpriseId,
            },
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Invalid request payload`,
            },
        });
    }
    /**
     * List Price Plans
     * @returns PricePlanListResponse Price plans
     * @throws ApiError
     */
    public static getEnterprisesPricePlans({
        enterpriseId,
        type,
        status,
        page = 1,
        pageSize = 20,
    }: {
        enterpriseId: string,
        type?: string,
        status?: string,
        page?: number,
        pageSize?: number,
    }): CancelablePromise<PricePlanListResponse> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/enterprises/{enterpriseId}/price-plans',
            path: {
                'enterpriseId': enterpriseId,
            },
            query: {
                'type': type,
                'status': status,
                'page': page,
                'pageSize': pageSize,
            },
        });
    }
    /**
     * Get Price Plan Detail
     * @returns PricePlanDetailResponse Price plan detail
     * @throws ApiError
     */
    public static getPricePlans({
        pricePlanId,
    }: {
        pricePlanId: string,
    }): CancelablePromise<PricePlanDetailResponse> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/price-plans/{pricePlanId}',
            path: {
                'pricePlanId': pricePlanId,
            },
        });
    }
    /**
     * Create Price Plan Version
     * @returns PricePlanVersionCreateResponse Price plan version created
     * @throws ApiError
     */
    public static postPricePlansVersions({
        pricePlanId,
        requestBody,
    }: {
        pricePlanId: string,
        requestBody: PricePlanVersionCreateRequest,
    }): CancelablePromise<PricePlanVersionCreateResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/price-plans/{pricePlanId}/versions',
            path: {
                'pricePlanId': pricePlanId,
            },
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Invalid request or type mismatch`,
                404: `Price plan not found`,
            },
        });
    }
}
