/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type AnomalySimsReport = {
    startDate?: string;
    endDate?: string;
    total?: number;
    items?: Array<{
        simId?: string;
        iccid?: string | null;
        alertCount?: number;
        latestAlertType?: string | null;
        latestSeverity?: string | null;
        latestStatus?: string | null;
        lastSeenAt?: string | null;
    }>;
};

