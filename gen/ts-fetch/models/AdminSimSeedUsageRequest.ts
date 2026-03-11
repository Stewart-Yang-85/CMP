/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type AdminSimSeedUsageRequest = {
    /**
     * ISO date YYYY-MM-DD
     */
    usageDay?: string;
    /**
     * MCC-MNC (e.g., 204-08)
     */
    visitedMccMnc?: string;
    totalKb?: number;
    uplinkKb?: number;
    downlinkKb?: number;
};

