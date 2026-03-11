/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type UsageTrendReport = {
    granularity?: 'day' | 'month';
    startDate?: string;
    endDate?: string;
    items?: Array<{
        period?: string;
        totalKb?: number;
    }>;
};

