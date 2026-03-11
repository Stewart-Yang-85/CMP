/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { AuthLoginRequest } from '../models/AuthLoginRequest';
import type { AuthLoginResponse } from '../models/AuthLoginResponse';
import type { AuthRefreshRequest } from '../models/AuthRefreshRequest';
import type { AuthRefreshResponse } from '../models/AuthRefreshResponse';
import type { AuthTokenRequest } from '../models/AuthTokenRequest';
import type { AuthTokenResponse } from '../models/AuthTokenResponse';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class AuthenticationService {
    /**
     * Get Access Token
     * Exchange client credentials for a Bearer token.
     * @returns AuthTokenResponse Successful authentication
     * @throws ApiError
     */
    public static postAuthToken({
        requestBody,
    }: {
        requestBody: AuthTokenRequest,
    }): CancelablePromise<AuthTokenResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/auth/token',
            body: requestBody,
            mediaType: 'application/json',
        });
    }
    /**
     * User Login
     * Exchange user credentials for a Bearer token.
     * @returns AuthLoginResponse Successful authentication
     * @throws ApiError
     */
    public static postAuthLogin({
        requestBody,
    }: {
        requestBody: AuthLoginRequest,
    }): CancelablePromise<AuthLoginResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/auth/login',
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Validation error`,
                401: `Unauthorized`,
            },
        });
    }
    /**
     * Refresh Access Token
     * Exchange refresh token for a new access token.
     * @returns AuthRefreshResponse Token refreshed
     * @throws ApiError
     */
    public static postAuthRefresh({
        requestBody,
    }: {
        requestBody: AuthRefreshRequest,
    }): CancelablePromise<AuthRefreshResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/auth/refresh',
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                400: `Validation error`,
                401: `Unauthorized`,
            },
        });
    }
}
