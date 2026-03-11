/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type WxWebhookTrafficAlertRequest = {
    messageType: string;
    iccid: string;
    msisdn: string;
    data: {
        thresholdReached: string;
        eventTime: string;
        limit: string;
        eventName: string;
        balanceAmount: string;
        addOnID: string;
    };
    sign: string;
    uuid: string;
};

