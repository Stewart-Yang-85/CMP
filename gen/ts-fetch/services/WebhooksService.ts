/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { WebhookDeliveryListResponse } from '../models/WebhookDeliveryListResponse';
import type { WebhookRetryResponse } from '../models/WebhookRetryResponse';
import type { WebhookSubscriptionCreateRequest } from '../models/WebhookSubscriptionCreateRequest';
import type { WebhookSubscriptionDeleteResponse } from '../models/WebhookSubscriptionDeleteResponse';
import type { WebhookSubscriptionListResponse } from '../models/WebhookSubscriptionListResponse';
import type { WebhookSubscriptionResponse } from '../models/WebhookSubscriptionResponse';
import type { WebhookSubscriptionUpdateRequest } from '../models/WebhookSubscriptionUpdateRequest';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class WebhooksService {
    /**
     * Create Webhook Subscription
     * @returns WebhookSubscriptionResponse Webhook subscription created
     * @throws ApiError
     */
    public static createWebhookSubscription({
        requestBody,
    }: {
        requestBody: WebhookSubscriptionCreateRequest,
    }): CancelablePromise<WebhookSubscriptionResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/webhook-subscriptions',
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Invalid request`,
                401: `Unauthorized`,
                403: `Forbidden`,
                404: `Target not found`,
            },
        });
    }
    /**
     * List Webhook Subscriptions
     * @returns WebhookSubscriptionListResponse Webhook subscriptions list
     * @throws ApiError
     */
    public static listWebhookSubscriptions({
        resellerId,
        enterpriseId,
        page = 1,
        pageSize = 20,
    }: {
        resellerId?: string,
        enterpriseId?: string,
        page?: number,
        pageSize?: number,
    }): CancelablePromise<WebhookSubscriptionListResponse> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/webhook-subscriptions',
            query: {
                'resellerId': resellerId,
                'enterpriseId': enterpriseId,
                'page': page,
                'pageSize': pageSize,
            },
            errors: {
                400: `Invalid request`,
                401: `Unauthorized`,
                403: `Forbidden`,
                404: `Target not found`,
            },
        });
    }
    /**
     * Get Webhook Subscription
     * @returns WebhookSubscriptionResponse Webhook subscription
     * @throws ApiError
     */
    public static getWebhookSubscription({
        webhookId,
    }: {
        webhookId: string,
    }): CancelablePromise<WebhookSubscriptionResponse> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/webhook-subscriptions/{webhookId}',
            path: {
                'webhookId': webhookId,
            },
            errors: {
                400: `Invalid request`,
                401: `Unauthorized`,
                403: `Forbidden`,
                404: `Not found`,
            },
        });
    }
    /**
     * Update Webhook Subscription
     * @returns WebhookSubscriptionResponse Webhook subscription updated
     * @throws ApiError
     */
    public static updateWebhookSubscription({
        webhookId,
        requestBody,
    }: {
        webhookId: string,
        requestBody: WebhookSubscriptionUpdateRequest,
    }): CancelablePromise<WebhookSubscriptionResponse> {
        return __request(OpenAPI, {
            method: 'PATCH',
            url: '/webhook-subscriptions/{webhookId}',
            path: {
                'webhookId': webhookId,
            },
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Invalid request`,
                401: `Unauthorized`,
                403: `Forbidden`,
                404: `Not found`,
            },
        });
    }
    /**
     * Delete Webhook Subscription
     * @returns WebhookSubscriptionDeleteResponse Webhook subscription deleted
     * @throws ApiError
     */
    public static deleteWebhookSubscription({
        webhookId,
    }: {
        webhookId: string,
    }): CancelablePromise<WebhookSubscriptionDeleteResponse> {
        return __request(OpenAPI, {
            method: 'DELETE',
            url: '/webhook-subscriptions/{webhookId}',
            path: {
                'webhookId': webhookId,
            },
            errors: {
                400: `Invalid request`,
                401: `Unauthorized`,
                403: `Forbidden`,
                404: `Not found`,
            },
        });
    }
    /**
     * List Webhook Deliveries
     * @returns WebhookDeliveryListResponse Webhook delivery list
     * @throws ApiError
     */
    public static listWebhookDeliveries({
        webhookId,
        page = 1,
        pageSize = 20,
    }: {
        webhookId: string,
        page?: number,
        pageSize?: number,
    }): CancelablePromise<WebhookDeliveryListResponse> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/webhook-subscriptions/{webhookId}/deliveries',
            path: {
                'webhookId': webhookId,
            },
            query: {
                'page': page,
                'pageSize': pageSize,
            },
            errors: {
                400: `Invalid request`,
                401: `Unauthorized`,
                403: `Forbidden`,
                404: `Not found`,
            },
        });
    }
    /**
     * Retry Webhook Delivery
     * @returns WebhookRetryResponse Webhook delivery retried
     * @throws ApiError
     */
    public static retryWebhookDelivery({
        deliveryId,
    }: {
        deliveryId: number,
    }): CancelablePromise<WebhookRetryResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/webhook-deliveries/{deliveryId}/retry',
            path: {
                'deliveryId': deliveryId,
            },
            errors: {
                400: `Invalid request`,
                401: `Unauthorized`,
                403: `Forbidden`,
                404: `Not found`,
            },
        });
    }
}
