/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ReconciliationMetrics } from './ReconciliationMetrics';
import type { ReconciliationMismatch } from './ReconciliationMismatch';
import type { ReconciliationSummary } from './ReconciliationSummary';
export type ReconciliationRunDetailResponse = {
    runId?: string;
    supplierId?: string;
    date?: string;
    status?: string;
    summary?: ReconciliationSummary;
    mismatches?: Array<ReconciliationMismatch>;
    metrics?: ReconciliationMetrics;
    completedAt?: string | null;
};

