/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { PricePlanCreateCommon } from './PricePlanCreateCommon';
export type PricePlanCreateFixedBundle = (PricePlanCreateCommon & {
    price_plan_type: 'FIXED_BUNDLE';
    monthlyFee: number;
    deactivatedMonthlyFee: number;
    totalQuotaKb: number;
    overageRatePerKb?: number;
});

