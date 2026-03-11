/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { PricePlanVersionCreateCommon } from './PricePlanVersionCreateCommon';
export type PricePlanVersionCreateSimDependentBundle = (PricePlanVersionCreateCommon & {
    price_plan_type: 'SIM_DEPENDENT_BUNDLE';
    monthlyFee: number;
    deactivatedMonthlyFee: number;
    perSimQuotaKb: number;
    overageRatePerKb?: number;
});

