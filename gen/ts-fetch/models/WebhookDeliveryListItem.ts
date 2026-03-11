/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type WebhookDeliveryListItem = {
    deliveryId?: number;
    webhookId?: string;
    eventId?: string;
    eventType?: string | null;
    attempt?: number;
    status?: string;
    responseCode?: number | null;
    responseBody?: string | null;
    nextRetryAt?: string | null;
    createdAt?: string;
};

