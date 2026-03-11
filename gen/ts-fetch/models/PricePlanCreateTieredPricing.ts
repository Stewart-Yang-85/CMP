/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { PricePlanCreateCommon } from './PricePlanCreateCommon';
import type { PricePlanTier } from './PricePlanTier';
export type PricePlanCreateTieredPricing = (PricePlanCreateCommon & {
    price_plan_type: 'TIERED_PRICING';
    monthlyFee: number;
    deactivatedMonthlyFee: number;
    tiers: Array<PricePlanTier>;
});

