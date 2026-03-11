/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { JobProgress } from './JobProgress';
export type JobListItem = {
    jobId?: string;
    jobType?: string;
    status?: string;
    progress?: JobProgress;
    startedAt?: string;
    finishedAt?: string | null;
    requestId?: string;
};

