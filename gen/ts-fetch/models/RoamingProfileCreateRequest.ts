/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { RoamingRateEntry } from './RoamingRateEntry';
export type RoamingProfileCreateRequest = {
    name: string;
    mccmncList: Array<RoamingRateEntry>;
    resellerId: string;
    supplierId: string;
    operatorId?: string;
};

