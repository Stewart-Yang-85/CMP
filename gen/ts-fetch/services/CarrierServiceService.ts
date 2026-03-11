/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { CarrierServiceValidateRequest } from '../models/CarrierServiceValidateRequest';
import type { CarrierServiceValidateResponse } from '../models/CarrierServiceValidateResponse';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class CarrierServiceService {
    /**
     * Validate Carrier Service Module
     * @returns CarrierServiceValidateResponse Carrier service validated
     * @throws ApiError
     */
    public static postCarrierServices:validate({
        requestBody,
    }: {
        requestBody: CarrierServiceValidateRequest,
    }): CancelablePromise<CarrierServiceValidateResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/carrier-services:validate',
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Invalid carrier service module`,
            },
        });
    }
}
