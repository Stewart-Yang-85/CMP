/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type WxWebhookSimStatusChangedRequest = {
    messageType: string;
    iccid: string;
    msisdn: string;
    sign: string;
    uuid: string;
    data: {
        toStatus: string;
        fromStatus: string;
        eventTime: string;
        transactionId: string;
    };
};

