/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class AuthenticationService {
    /**
     * Get Access Token
     * Exchange client credentials for a Bearer token.
     * @returns any Successful authentication
     * @throws ApiError
     */
    public static postAuthToken({
        requestBody,
    }: {
        requestBody: {
            clientId: string;
            clientSecret: string;
        },
    }): CancelablePromise<{
        accessToken?: string;
        expiresIn?: number;
    }> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/auth/token',
            body: requestBody,
            mediaType: 'application/json',
        });
    }
}
