/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { PricePlanTier } from './PricePlanTier';
import type { PricePlanVersionCreateCommon } from './PricePlanVersionCreateCommon';
export type PricePlanVersionCreateTieredPricing = (PricePlanVersionCreateCommon & {
    price_plan_type: 'TIERED_PRICING';
    monthlyFee: number;
    deactivatedMonthlyFee: number;
    tiers: Array<PricePlanTier>;
});

