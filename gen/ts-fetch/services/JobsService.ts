/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { Job } from '../models/Job';
import type { JobCancelResponse } from '../models/JobCancelResponse';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class JobsService {
    /**
     * Get Job Status
     * @returns Job Job details
     * @throws ApiError
     */
    public static getJobs({
        jobId,
    }: {
        jobId: string,
    }): CancelablePromise<Job> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/jobs/{jobId}',
            path: {
                'jobId': jobId,
            },
        });
    }
    /**
     * Cancel Job
     * Cancels a queued or running job.
     * @returns JobCancelResponse Job cancelled
     * @throws ApiError
     */
    public static postJobs-:cancel({
        jobId,
    }: {
        jobId: string,
    }): CancelablePromise<JobCancelResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/jobs/{jobId}:cancel',
            path: {
                'jobId': jobId,
            },
            errors: {
                401: `Unauthorized`,
                403: `Forbidden`,
                404: `Job not found`,
                409: `Invalid job state`,
            },
        });
    }
}
