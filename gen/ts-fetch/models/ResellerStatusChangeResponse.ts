/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type ResellerStatusChangeResponse = {
    resellerId?: string;
    status?: 'ACTIVE' | 'DEACTIVATED' | 'SUSPENDED';
    previousStatus?: 'ACTIVE' | 'DEACTIVATED' | 'SUSPENDED';
    changedAt?: string;
};

