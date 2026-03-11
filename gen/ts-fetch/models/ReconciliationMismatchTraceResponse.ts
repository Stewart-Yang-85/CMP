/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ReconciliationMismatch } from './ReconciliationMismatch';
export type ReconciliationMismatchTraceResponse = {
    run?: {
        runId?: string;
        date?: string;
        scope?: string;
        status?: string;
        startedAt?: string | null;
        completedAt?: string | null;
    };
    mismatch?: ReconciliationMismatch;
    sim?: {
        simId?: string;
        iccid?: string;
        status?: string;
        upstreamStatus?: string | null;
        upstreamStatusUpdatedAt?: string | null;
        enterpriseId?: string | null;
        departmentId?: string | null;
        supplierId?: string | null;
        carrierId?: string | null;
    } | null;
    simStateHistory?: Array<{
        beforeStatus?: string;
        afterStatus?: string;
        startTime?: string;
        endTime?: string | null;
        source?: string;
        requestId?: string | null;
    }>;
    events?: Array<Record<string, any>>;
    audits?: Array<Record<string, any>>;
};

