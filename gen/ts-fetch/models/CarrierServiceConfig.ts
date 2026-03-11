/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { RoamingProfileConfig } from './RoamingProfileConfig';
export type CarrierServiceConfig = {
    roamingProfileId?: string;
    supplierId?: string;
    carrierId?: string;
    rat?: '4G' | '3G' | '5G' | 'NB-IoT';
    apn?: string;
    apnProfileVersionId?: string;
    roamingProfileVersionId: string;
    roamingProfile?: RoamingProfileConfig;
};

