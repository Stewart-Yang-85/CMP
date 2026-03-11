/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type SimBatchDeactivateJobResponse = {
    jobId?: string;
    status?: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
    progress?: {
        processed?: number;
        total?: number;
    };
};

