/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { PricePlanVersionCreateCommon } from './PricePlanVersionCreateCommon';
export type PricePlanVersionCreateFixedBundle = (PricePlanVersionCreateCommon & {
    price_plan_type: 'FIXED_BUNDLE';
    monthlyFee: number;
    deactivatedMonthlyFee: number;
    totalQuotaKb: number;
    overageRatePerKb?: number;
});

