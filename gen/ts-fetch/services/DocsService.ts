/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ShareLinkCreateRequest } from '../models/ShareLinkCreateRequest';
import type { ShareLinkCreateResponse } from '../models/ShareLinkCreateResponse';
import type { ShareLinkParamsResponse } from '../models/ShareLinkParamsResponse';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class DocsService {
    /**
     * Create Share Link
     * Creates a short share link for Docs filters. Returns a short code and URL.
     * @returns ShareLinkCreateResponse Share link created
     * @throws ApiError
     */
    public static postShareLinks({
        requestBody,
    }: {
        requestBody: ShareLinkCreateRequest,
    }): CancelablePromise<ShareLinkCreateResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/share-links',
            body: requestBody,
            mediaType: 'application/json',
        });
    }
    /**
     * Get Share Link Params
     * Returns the saved filter parameters for a given share code.
     * @returns ShareLinkParamsResponse Share link params
     * @throws ApiError
     */
    public static getSJson({
        code,
    }: {
        code: string,
    }): CancelablePromise<ShareLinkParamsResponse> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/s/{code}.json',
            path: {
                'code': code,
            },
            errors: {
                404: `Not found`,
            },
        });
    }
    /**
     * Open Share Link
     * Redirects the browser to Docs with the shareCode applied.
     * @returns void
     * @throws ApiError
     */
    public static getS({
        code,
    }: {
        code: string,
    }): CancelablePromise<void> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/s/{code}',
            path: {
                'code': code,
            },
            errors: {
                302: `Redirect to Docs`,
            },
        });
    }
}
