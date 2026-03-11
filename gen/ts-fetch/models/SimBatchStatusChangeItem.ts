/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { SimBatchStatusChangeErrorCode } from './SimBatchStatusChangeErrorCode';
export type SimBatchStatusChangeItem = {
    input?: string | null;
    simId?: string | null;
    iccid?: string | null;
    ok?: boolean;
    idempotent?: boolean | null;
    beforeStatus?: string | null;
    afterStatus?: string | null;
    errorCode?: SimBatchStatusChangeErrorCode | null;
    errorMessage?: string | null;
};

