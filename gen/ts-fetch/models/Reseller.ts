/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ResellerBrandingConfig } from './ResellerBrandingConfig';
export type Reseller = {
    resellerId?: string;
    name?: string;
    currency?: string | null;
    status?: 'ACTIVE' | 'DEACTIVATED' | 'SUSPENDED';
    brandingConfig?: ResellerBrandingConfig;
    createdAt?: string;
};

