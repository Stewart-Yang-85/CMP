/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type WebhookSubscriptionCreateRequest = {
    resellerId?: string | null;
    enterpriseId?: string | null;
    url: string;
    secret: string;
    eventTypes: Array<string>;
    enabled?: boolean;
    description?: string | null;
};

