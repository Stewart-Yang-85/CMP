/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type WxWebhookProductOrderRequest = {
    messageType: string;
    iccid: string;
    msisdn: string;
    data: {
        addOnId: string;
        addOnType: string;
        startDate: string;
        transactionId: string;
        expirationDate: string;
    };
    sign: string;
    uuid: string;
};

