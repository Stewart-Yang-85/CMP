/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type SimBatchStatusChangeRequest = {
    action: 'ACTIVATE' | 'DEACTIVATE' | 'REACTIVATE' | 'RETIRE';
    iccids: Array<string>;
    enterpriseId?: string | null;
    reason?: string | null;
    confirm?: boolean;
    commitmentExempt?: boolean;
};

