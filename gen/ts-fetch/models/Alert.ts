/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type Alert = {
    alertId?: string;
    alertType?: 'POOL_USAGE_HIGH' | 'OUT_OF_PROFILE_SURGE' | 'SILENT_SIM' | 'UNEXPECTED_ROAMING' | 'CDR_DELAY' | 'UPSTREAM_DISCONNECT';
    severity?: 'P0' | 'P1' | 'P2' | 'P3';
    status?: 'OPEN' | 'ACKED' | 'RESOLVED' | 'SUPPRESSED';
    enterpriseId?: string | null;
    simId?: string | null;
    iccid?: string | null;
    threshold?: number | null;
    currentValue?: number | null;
    message?: string | null;
    metadata?: Record<string, any> | null;
    windowStart?: string;
    windowEnd?: string | null;
    firstSeenAt?: string | null;
    lastSeenAt?: string | null;
    acknowledgedAt?: string | null;
    acknowledgedBy?: string | null;
    suppressedUntil?: string | null;
    createdAt?: string | null;
    updatedAt?: string | null;
};

