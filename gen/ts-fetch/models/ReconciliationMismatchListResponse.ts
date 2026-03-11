/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ReconciliationMetrics } from './ReconciliationMetrics';
import type { ReconciliationMismatch } from './ReconciliationMismatch';
export type ReconciliationMismatchListResponse = {
    items?: Array<ReconciliationMismatch>;
    total?: number;
    page?: number;
    pageSize?: number;
    metrics?: ReconciliationMetrics;
};

