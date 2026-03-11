/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { PricePlanVersion } from './PricePlanVersion';
export type PricePlanDetailResponse = {
    pricePlanId?: string;
    enterpriseId?: string;
    name?: string;
    type?: string;
    serviceType?: string;
    currency?: string;
    billingCycleType?: string;
    firstCycleProration?: string;
    createdAt?: string;
    currentVersion?: PricePlanVersion;
    versions?: Array<PricePlanVersion>;
};

