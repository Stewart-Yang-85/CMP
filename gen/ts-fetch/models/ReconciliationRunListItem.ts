/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ReconciliationSummary } from './ReconciliationSummary';
export type ReconciliationRunListItem = {
    runId?: string;
    supplierId?: string;
    date?: string;
    scope?: string;
    status?: string;
    summary?: ReconciliationSummary;
    startedAt?: string | null;
    completedAt?: string | null;
};

