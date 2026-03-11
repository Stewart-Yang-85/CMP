/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type WxWebhookSimOnlineRequest = {
    messageType: string;
    iccid: string;
    msisdn: string;
    sign: string;
    uuid: string;
    data: {
        mncList: string;
        eventTime: string;
        mcc: string;
    };
};

