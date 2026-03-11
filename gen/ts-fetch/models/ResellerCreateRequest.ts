/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ResellerBrandingConfig } from './ResellerBrandingConfig';
export type ResellerCreateRequest = {
    name: string;
    /**
     * ISO 4217 currency code
     */
    currency: string;
    contactEmail: string;
    contactPhone?: string | null;
    brandingConfig?: ResellerBrandingConfig;
};

