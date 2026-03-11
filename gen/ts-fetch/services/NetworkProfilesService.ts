/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ApnProfileCreateRequest } from '../models/ApnProfileCreateRequest';
import type { ApnProfileCreateResponse } from '../models/ApnProfileCreateResponse';
import type { ApnProfileDetailResponse } from '../models/ApnProfileDetailResponse';
import type { ApnProfileListResponse } from '../models/ApnProfileListResponse';
import type { ApnProfileVersionCreateRequest } from '../models/ApnProfileVersionCreateRequest';
import type { ProfilePublishResponse } from '../models/ProfilePublishResponse';
import type { ProfileRollbackResponse } from '../models/ProfileRollbackResponse';
import type { ProfileVersionCreateResponse } from '../models/ProfileVersionCreateResponse';
import type { RoamingProfileCreateRequest } from '../models/RoamingProfileCreateRequest';
import type { RoamingProfileCreateResponse } from '../models/RoamingProfileCreateResponse';
import type { RoamingProfileDetailResponse } from '../models/RoamingProfileDetailResponse';
import type { RoamingProfileListResponse } from '../models/RoamingProfileListResponse';
import type { RoamingProfileVersionCreateRequest } from '../models/RoamingProfileVersionCreateRequest';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class NetworkProfilesService {
    /**
     * Create APN Profile
     * @returns ApnProfileCreateResponse APN profile created
     * @throws ApiError
     */
    public static postApnProfiles({
        requestBody,
    }: {
        requestBody: ApnProfileCreateRequest,
    }): CancelablePromise<ApnProfileCreateResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/apn-profiles',
            body: requestBody,
            mediaType: 'application/json',
        });
    }
    /**
     * List APN Profiles
     * @returns ApnProfileListResponse APN profiles
     * @throws ApiError
     */
    public static getApnProfiles({
        supplierId,
        operatorId,
        status,
        page = 1,
        pageSize = 20,
    }: {
        /**
         * supplierId 和 operatorId 至少提供一个
         */
        supplierId?: string,
        /**
         * supplierId 和 operatorId 至少提供一个
         */
        operatorId?: string,
        status?: string,
        page?: number,
        pageSize?: number,
    }): CancelablePromise<ApnProfileListResponse> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/apn-profiles',
            query: {
                'supplierId': supplierId,
                'operatorId': operatorId,
                'status': status,
                'page': page,
                'pageSize': pageSize,
            },
            errors: {
                400: `supplierId 和 operatorId 不能同时为空`,
            },
        });
    }
    /**
     * Create Roaming Profile
     * @returns RoamingProfileCreateResponse Roaming profile created
     * @throws ApiError
     */
    public static postRoamingProfiles({
        requestBody,
    }: {
        requestBody: RoamingProfileCreateRequest,
    }): CancelablePromise<RoamingProfileCreateResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/roaming-profiles',
            body: requestBody,
            mediaType: 'application/json',
        });
    }
    /**
     * List Roaming Profiles
     * @returns RoamingProfileListResponse Roaming profiles
     * @throws ApiError
     */
    public static getRoamingProfiles({
        supplierId,
        operatorId,
        status,
        page = 1,
        pageSize = 20,
    }: {
        /**
         * supplierId 和 operatorId 至少提供一个
         */
        supplierId?: string,
        /**
         * supplierId 和 operatorId 至少提供一个
         */
        operatorId?: string,
        status?: string,
        page?: number,
        pageSize?: number,
    }): CancelablePromise<RoamingProfileListResponse> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/roaming-profiles',
            query: {
                'supplierId': supplierId,
                'operatorId': operatorId,
                'status': status,
                'page': page,
                'pageSize': pageSize,
            },
            errors: {
                400: `supplierId 和 operatorId 不能同时为空`,
            },
        });
    }
    /**
     * Get APN Profile Detail
     * @returns ApnProfileDetailResponse APN profile detail
     * @throws ApiError
     */
    public static getApnProfiles1({
        apnProfileId,
    }: {
        apnProfileId: string,
    }): CancelablePromise<ApnProfileDetailResponse> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/apn-profiles/{apnProfileId}',
            path: {
                'apnProfileId': apnProfileId,
            },
        });
    }
    /**
     * Get Roaming Profile Detail
     * @returns RoamingProfileDetailResponse Roaming profile detail
     * @throws ApiError
     */
    public static getRoamingProfiles1({
        roamingProfileId,
    }: {
        roamingProfileId: string,
    }): CancelablePromise<RoamingProfileDetailResponse> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/roaming-profiles/{roamingProfileId}',
            path: {
                'roamingProfileId': roamingProfileId,
            },
        });
    }
    /**
     * Create APN Profile Version
     * @returns ProfileVersionCreateResponse APN profile version created
     * @throws ApiError
     */
    public static postApnProfilesVersions({
        apnProfileId,
        requestBody,
    }: {
        apnProfileId: string,
        requestBody: ApnProfileVersionCreateRequest,
    }): CancelablePromise<ProfileVersionCreateResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/apn-profiles/{apnProfileId}/versions',
            path: {
                'apnProfileId': apnProfileId,
            },
            body: requestBody,
            mediaType: 'application/json',
        });
    }
    /**
     * Create Roaming Profile Version
     * @returns ProfileVersionCreateResponse Roaming profile version created
     * @throws ApiError
     */
    public static postRoamingProfilesVersions({
        roamingProfileId,
        requestBody,
    }: {
        roamingProfileId: string,
        requestBody: RoamingProfileVersionCreateRequest,
    }): CancelablePromise<ProfileVersionCreateResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/roaming-profiles/{roamingProfileId}/versions',
            path: {
                'roamingProfileId': roamingProfileId,
            },
            body: requestBody,
            mediaType: 'application/json',
        });
    }
    /**
     * Publish APN Profile
     * @returns ProfilePublishResponse APN profile published
     * @throws ApiError
     */
    public static postApnProfiles-:publish({
        apnProfileId,
    }: {
        apnProfileId: string,
    }): CancelablePromise<ProfilePublishResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/apn-profiles/{apnProfileId}:publish',
            path: {
                'apnProfileId': apnProfileId,
            },
        });
    }
    /**
     * Publish Roaming Profile
     * @returns ProfilePublishResponse Roaming profile published
     * @throws ApiError
     */
    public static postRoamingProfiles-:publish({
        roamingProfileId,
    }: {
        roamingProfileId: string,
    }): CancelablePromise<ProfilePublishResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/roaming-profiles/{roamingProfileId}:publish',
            path: {
                'roamingProfileId': roamingProfileId,
            },
        });
    }
    /**
     * Rollback Scheduled Profile Version
     * @returns ProfileRollbackResponse Profile version rollback completed
     * @throws ApiError
     */
    public static postProfileVersions-:rollback({
        profileVersionId,
    }: {
        profileVersionId: string,
    }): CancelablePromise<ProfileRollbackResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/profile-versions/{profileVersionId}:rollback',
            path: {
                'profileVersionId': profileVersionId,
            },
        });
    }
}
