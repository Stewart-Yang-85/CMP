/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { CarrierServiceConfig } from './CarrierServiceConfig';
import type { CommercialTerms } from './CommercialTerms';
import type { ControlPolicy } from './ControlPolicy';
import type { PaygRate } from './PaygRate';
import type { PricePlanTier } from './PricePlanTier';
export type PricePlanVersion = {
    pricePlanVersionId?: string;
    version?: number;
    status?: string;
    effectiveFrom?: string;
    monthlyFee?: number;
    deactivatedMonthlyFee?: number;
    oneTimeFee?: number;
    quotaKb?: number;
    validityDays?: number;
    perSimQuotaKb?: number;
    totalQuotaKb?: number;
    overageRatePerKb?: number;
    tiers?: Array<PricePlanTier>;
    paygRates?: Array<PaygRate>;
    commercialTerms?: CommercialTerms;
    controlPolicy?: ControlPolicy;
    carrierServiceConfig?: CarrierServiceConfig;
    carrierService?: CarrierServiceConfig;
    createdAt?: string;
};

