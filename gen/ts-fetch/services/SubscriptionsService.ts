/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { SubscriptionCancelRequest } from '../models/SubscriptionCancelRequest';
import type { SubscriptionCancelResponse } from '../models/SubscriptionCancelResponse';
import type { SubscriptionCreateRequest } from '../models/SubscriptionCreateRequest';
import type { SubscriptionCreateResponse } from '../models/SubscriptionCreateResponse';
import type { SubscriptionSwitchRequest } from '../models/SubscriptionSwitchRequest';
import type { SubscriptionSwitchResponse } from '../models/SubscriptionSwitchResponse';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class SubscriptionsService {
    /**
     * Create Subscription
     * Create MAIN or ADD_ON subscription for a SIM.
     * @returns SubscriptionCreateResponse Subscription created
     * @throws ApiError
     */
    public static postSubscriptions({
        requestBody,
    }: {
        requestBody: SubscriptionCreateRequest,
    }): CancelablePromise<SubscriptionCreateResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/subscriptions',
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Invalid request (missing parameters or invalid effectiveAt)`,
                401: `Unauthorized`,
                403: `SIM does not belong to your enterprise`,
                404: `SIM or packageVersion not found`,
                409: `Conflict creating immediate MAIN subscription`,
            },
        });
    }
    /**
     * Switch MAIN Subscription
     * Expire current MAIN subscription and schedule next-cycle subscription.
     * @returns SubscriptionSwitchResponse Switch scheduled
     * @throws ApiError
     */
    public static postSubscriptions:switch({
        requestBody,
    }: {
        requestBody: SubscriptionSwitchRequest,
    }): CancelablePromise<SubscriptionSwitchResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/subscriptions:switch',
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Only MAIN subscription can be switched`,
                401: `Unauthorized`,
                403: `SIM does not belong to your enterprise`,
                404: `SIM or subscription or packageVersion not found`,
            },
        });
    }
    /**
     * Cancel Subscription
     * Cancel an existing subscription immediately or at month end.
     * @returns SubscriptionCancelResponse Cancellation accepted
     * @throws ApiError
     */
    public static postSubscriptions-:cancel({
        subscriptionId,
        requestBody,
    }: {
        subscriptionId: string,
        requestBody?: SubscriptionCancelRequest,
    }): CancelablePromise<SubscriptionCancelResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/subscriptions/{subscriptionId}:cancel',
            path: {
                'subscriptionId': subscriptionId,
            },
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                401: `Unauthorized`,
                403: `Subscription does not belong to your enterprise`,
                404: `Subscription not found`,
            },
        });
    }
}
