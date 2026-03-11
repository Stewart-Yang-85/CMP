/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type Subscription = {
    subscriptionId?: string;
    enterpriseId?: string;
    simId?: string;
    kind?: 'MAIN' | 'ADD_ON';
    packageVersionId?: string;
    state?: 'ACTIVE' | 'PENDING' | 'CANCELLED' | 'EXPIRED';
    effectiveAt?: string;
    expiresAt?: string | null;
    cancelledAt?: string | null;
    commitmentEndAt?: string | null;
};

