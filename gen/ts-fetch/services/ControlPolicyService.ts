/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ControlPolicyValidateRequest } from '../models/ControlPolicyValidateRequest';
import type { ControlPolicyValidateResponse } from '../models/ControlPolicyValidateResponse';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class ControlPolicyService {
    /**
     * Validate Control Policy Module
     * @returns ControlPolicyValidateResponse Control policy validated
     * @throws ApiError
     */
    public static postControlPolicies:validate({
        requestBody,
    }: {
        requestBody: ControlPolicyValidateRequest,
    }): CancelablePromise<ControlPolicyValidateResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/control-policies:validate',
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Invalid control policy`,
            },
        });
    }
}
