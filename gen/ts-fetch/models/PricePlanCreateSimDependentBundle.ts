/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { PricePlanCreateCommon } from './PricePlanCreateCommon';
export type PricePlanCreateSimDependentBundle = (PricePlanCreateCommon & {
    price_plan_type: 'SIM_DEPENDENT_BUNDLE';
    monthlyFee: number;
    deactivatedMonthlyFee: number;
    perSimQuotaKb: number;
    overageRatePerKb?: number;
});

