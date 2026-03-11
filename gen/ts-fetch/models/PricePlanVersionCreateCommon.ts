/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { CarrierServiceConfig } from './CarrierServiceConfig';
import type { CommercialTerms } from './CommercialTerms';
import type { ControlPolicy } from './ControlPolicy';
import type { PaygRate } from './PaygRate';
export type PricePlanVersionCreateCommon = {
    price_plan_type: 'ONE_TIME' | 'SIM_DEPENDENT_BUNDLE' | 'FIXED_BUNDLE' | 'TIERED_PRICING';
    prorationRounding?: 'ROUND_HALF_UP';
    paygRates?: Array<PaygRate>;
    commercialTerms: CommercialTerms;
    controlPolicy: ControlPolicy;
    carrierServiceConfig: CarrierServiceConfig;
    carrierService?: CarrierServiceConfig;
};

