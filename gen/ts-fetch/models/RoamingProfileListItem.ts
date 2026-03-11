/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ProfileVersion } from './ProfileVersion';
import type { RoamingRateEntry } from './RoamingRateEntry';
export type RoamingProfileListItem = {
    roamingProfileId?: string;
    name?: string;
    mccmncList?: Array<RoamingRateEntry>;
    supplierId?: string;
    carrierId?: string;
    status?: string;
    currentVersion?: ProfileVersion;
};

