/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { PricePlanVersionCreateCommon } from './PricePlanVersionCreateCommon';
export type PricePlanVersionCreateOneTime = (PricePlanVersionCreateCommon & {
    price_plan_type: 'ONE_TIME';
    oneTimeFee: number;
    quotaKb: number;
    validityDays: number;
    expiryBoundary: 'CALENDAR_DAY_END' | 'DURATION_EXCLUSIVE_END';
});

