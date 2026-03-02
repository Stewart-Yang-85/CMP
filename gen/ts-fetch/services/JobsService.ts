/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { Job } from '../models/Job';
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
}
