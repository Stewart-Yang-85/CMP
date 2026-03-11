/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { CommercialTermsValidateRequest } from '../models/CommercialTermsValidateRequest';
import type { CommercialTermsValidateResponse } from '../models/CommercialTermsValidateResponse';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class CommercialTermsService {
    /**
     * Validate Commercial Terms Module
     * @returns CommercialTermsValidateResponse Commercial terms validated
     * @throws ApiError
     */
    public static postCommercialTerms:validate({
        requestBody,
    }: {
        requestBody: CommercialTermsValidateRequest,
    }): CancelablePromise<CommercialTermsValidateResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/commercial-terms:validate',
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Invalid commercial terms`,
            },
        });
    }
}
