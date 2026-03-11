/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type ApnProfileCreateRequest = {
    name: string;
    apn: string;
    authType?: 'NONE' | 'PAP' | 'CHAP';
    username?: string;
    passwordRef?: string;
    supplierId: string;
    operatorId: string;
};

