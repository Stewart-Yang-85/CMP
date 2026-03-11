/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { SimBatchStatusChangeItem } from './SimBatchStatusChangeItem';
export type SimBatchStatusChangeResponse = {
    action?: string;
    targetStatus?: string;
    total?: number;
    succeeded?: number;
    failed?: number;
    idempotent?: number;
    items?: Array<SimBatchStatusChangeItem>;
};

