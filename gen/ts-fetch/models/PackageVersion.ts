/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { CarrierServiceConfig } from './CarrierServiceConfig';
import type { CommercialTerms } from './CommercialTerms';
import type { ControlPolicy } from './ControlPolicy';
import type { RoamingProfileConfig } from './RoamingProfileConfig';
export type PackageVersion = {
    packageVersionId?: string;
    version?: number;
    status?: string;
    effectiveFrom?: string;
    supplierId?: string;
    operatorId?: string;
    carrierId?: string;
    serviceType?: string;
    apn?: string;
    roamingProfile?: RoamingProfileConfig;
    carrierServiceConfig?: CarrierServiceConfig;
    controlPolicy?: ControlPolicy;
    commercialTerms?: CommercialTerms;
    pricePlanVersionId?: string;
    createdAt?: string;
};

