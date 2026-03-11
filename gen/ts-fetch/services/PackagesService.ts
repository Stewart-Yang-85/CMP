/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { PackageCreateRequest } from '../models/PackageCreateRequest';
import type { PackageCreateResponse } from '../models/PackageCreateResponse';
import type { PackageDetailResponse } from '../models/PackageDetailResponse';
import type { PackageListResponse } from '../models/PackageListResponse';
import type { PackagePublishResponse } from '../models/PackagePublishResponse';
import type { PackageSummaryListResponse } from '../models/PackageSummaryListResponse';
import type { PackageUpdateRequest } from '../models/PackageUpdateRequest';
import type { PackageUpdateResponse } from '../models/PackageUpdateResponse';
import type { PackageVersionListResponse } from '../models/PackageVersionListResponse';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class PackagesService {
    /**
     * List Package Versions
     * Lists package versions accessible to the calling enterprise.
     * @returns PackageVersionListResponse Package versions
     * @throws ApiError
     */
    public static getPackageVersions({
        limit = 50,
        page = 1,
        status,
        serviceType,
        effectiveFromStart,
        effectiveFromEnd,
        mcc,
        mnc,
        mccmnc,
        carrierNameLike,
        mccmncList,
        carrierName,
        carrierId,
        apnLike,
        sortBy,
        sortOrder,
        packageId,
        q,
    }: {
        limit?: number,
        page?: number,
        /**
         * Filter by status (e.g., ACTIVE, DRAFT)
         */
        status?: string,
        /**
         * Filter by service type (e.g., DATA)
         */
        serviceType?: string,
        /**
         * Filter by versions with effectiveFrom >= the given time
         */
        effectiveFromStart?: string,
        /**
         * Filter by versions with effectiveFrom <= the given time
         */
        effectiveFromEnd?: string,
        /**
         * Filter by carrier MCC
         */
        mcc?: string,
        /**
         * Filter by carrier MNC
         */
        mnc?: string,
        /**
         * Filter by combined MCC+MNC (5 or 6 digits)
         */
        mccmnc?: string,
        /**
         * Filter by carrier name substring (case-insensitive)
         */
        carrierNameLike?: string,
        /**
         * Comma-separated MCCMNC list (each 5 or 6 digits)
         */
        mccmncList?: string,
        /**
         * Filter by carrier exact name (case sensitive)
         */
        carrierName?: string,
        /**
         * Filter by carrier UUID
         */
        carrierId?: string,
        /**
         * Filter by APN substring (case-insensitive)
         */
        apnLike?: string,
        /**
         * Sort field
         */
        sortBy?: 'createdAt' | 'effectiveFrom' | 'status',
        /**
         * Sort direction
         */
        sortOrder?: 'asc' | 'desc',
        /**
         * Filter by specific package UUID
         */
        packageId?: string,
        /**
         * Filter by package name substring (case-insensitive)
         */
        q?: string,
    }): CancelablePromise<PackageVersionListResponse> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/package-versions',
            query: {
                'limit': limit,
                'page': page,
                'status': status,
                'serviceType': serviceType,
                'effectiveFromStart': effectiveFromStart,
                'effectiveFromEnd': effectiveFromEnd,
                'mcc': mcc,
                'mnc': mnc,
                'mccmnc': mccmnc,
                'carrierNameLike': carrierNameLike,
                'mccmncList': mccmncList,
                'carrierName': carrierName,
                'carrierId': carrierId,
                'apnLike': apnLike,
                'sortBy': sortBy,
                'sortOrder': sortOrder,
                'packageId': packageId,
                'q': q,
            },
        });
    }
    /**
     * Export Package Versions CSV
     * Exports package versions accessible to the calling enterprise as CSV.
     * @returns string CSV file of package versions
     * @throws ApiError
     */
    public static packageVersionsCsv({
        limit = 1000,
        page = 1,
        status,
        serviceType,
        effectiveFromStart,
        effectiveFromEnd,
        mcc,
        mnc,
        mccmnc,
        carrierNameLike,
        mccmncList,
        carrierName,
        carrierId,
        apnLike,
        sortBy,
        sortOrder,
        packageId,
        q,
    }: {
        limit?: number,
        page?: number,
        /**
         * Filter by status (e.g., ACTIVE, DRAFT)
         */
        status?: string,
        /**
         * Filter by service type (e.g., DATA)
         */
        serviceType?: string,
        /**
         * Filter by versions with effectiveFrom >= the given time
         */
        effectiveFromStart?: string,
        /**
         * Filter by versions with effectiveFrom <= the given time
         */
        effectiveFromEnd?: string,
        /**
         * Filter by carrier MCC
         */
        mcc?: string,
        /**
         * Filter by carrier MNC
         */
        mnc?: string,
        /**
         * Filter by combined MCC+MNC (5 or 6 digits)
         */
        mccmnc?: string,
        /**
         * Filter by carrier name substring (case-insensitive)
         */
        carrierNameLike?: string,
        /**
         * Comma-separated MCCMNC list (each 5 or 6 digits)
         */
        mccmncList?: string,
        /**
         * Filter by carrier exact name (case sensitive)
         */
        carrierName?: string,
        /**
         * Filter by carrier UUID
         */
        carrierId?: string,
        /**
         * Filter by APN substring (case-insensitive)
         */
        apnLike?: string,
        /**
         * Sort field
         */
        sortBy?: 'createdAt' | 'effectiveFrom' | 'status',
        /**
         * Sort direction
         */
        sortOrder?: 'asc' | 'desc',
        /**
         * Filter by specific package UUID
         */
        packageId?: string,
        /**
         * Filter by package name substring (case-insensitive)
         */
        q?: string,
    }): CancelablePromise<string> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/package-versions:csv',
            query: {
                'limit': limit,
                'page': page,
                'status': status,
                'serviceType': serviceType,
                'effectiveFromStart': effectiveFromStart,
                'effectiveFromEnd': effectiveFromEnd,
                'mcc': mcc,
                'mnc': mnc,
                'mccmnc': mccmnc,
                'carrierNameLike': carrierNameLike,
                'mccmncList': mccmncList,
                'carrierName': carrierName,
                'carrierId': carrierId,
                'apnLike': apnLike,
                'sortBy': sortBy,
                'sortOrder': sortOrder,
                'packageId': packageId,
                'q': q,
            },
        });
    }
    /**
     * List Packages
     * Lists packages accessible to the calling enterprise.
     * @returns PackageSummaryListResponse Packages
     * @throws ApiError
     */
    public static getPackages({
        q,
        sortBy,
        sortOrder,
        limit = 100,
        page = 1,
    }: {
        /**
         * Filter by package name substring (case-insensitive)
         */
        q?: string,
        /**
         * Sort field
         */
        sortBy?: 'name',
        /**
         * Sort direction
         */
        sortOrder?: 'asc' | 'desc',
        limit?: number,
        page?: number,
    }): CancelablePromise<PackageSummaryListResponse> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/packages',
            query: {
                'q': q,
                'sortBy': sortBy,
                'sortOrder': sortOrder,
                'limit': limit,
                'page': page,
            },
        });
    }
    /**
     * Export Packages CSV
     * Exports packages accessible to the calling enterprise as CSV.
     * @returns string CSV file of packages
     * @throws ApiError
     */
    public static packagesCsv({
        q,
        sortBy,
        sortOrder,
        limit = 1000,
        page = 1,
    }: {
        /**
         * Filter by package name substring (case-insensitive)
         */
        q?: string,
        /**
         * Sort field
         */
        sortBy?: 'name',
        /**
         * Sort direction
         */
        sortOrder?: 'asc' | 'desc',
        limit?: number,
        page?: number,
    }): CancelablePromise<string> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/packages:csv',
            query: {
                'q': q,
                'sortBy': sortBy,
                'sortOrder': sortOrder,
                'limit': limit,
                'page': page,
            },
        });
    }
    /**
     * Create Package
     * @returns PackageCreateResponse Package created
     * @throws ApiError
     */
    public static postEnterprisesPackages({
        enterpriseId,
        requestBody,
    }: {
        enterpriseId: string,
        requestBody: PackageCreateRequest,
    }): CancelablePromise<PackageCreateResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/enterprises/{enterpriseId}/packages',
            path: {
                'enterpriseId': enterpriseId,
            },
            body: requestBody,
            mediaType: 'application/json',
        });
    }
    /**
     * List Packages for Enterprise
     * @returns PackageListResponse Packages
     * @throws ApiError
     */
    public static getEnterprisesPackages({
        enterpriseId,
        status,
        page = 1,
        pageSize = 20,
    }: {
        enterpriseId: string,
        status?: string,
        page?: number,
        pageSize?: number,
    }): CancelablePromise<PackageListResponse> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/enterprises/{enterpriseId}/packages',
            path: {
                'enterpriseId': enterpriseId,
            },
            query: {
                'status': status,
                'page': page,
                'pageSize': pageSize,
            },
        });
    }
    /**
     * Get Package Detail
     * @returns PackageDetailResponse Package detail
     * @throws ApiError
     */
    public static getPackages1({
        packageId,
    }: {
        packageId: string,
    }): CancelablePromise<PackageDetailResponse> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/packages/{packageId}',
            path: {
                'packageId': packageId,
            },
        });
    }
    /**
     * Update Package Draft
     * @returns PackageUpdateResponse Package updated
     * @throws ApiError
     */
    public static putPackages({
        packageId,
        requestBody,
    }: {
        packageId: string,
        requestBody: PackageUpdateRequest,
    }): CancelablePromise<PackageUpdateResponse> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/packages/{packageId}',
            path: {
                'packageId': packageId,
            },
            body: requestBody,
            mediaType: 'application/json',
        });
    }
    /**
     * Publish Package
     * @returns PackagePublishResponse Package published
     * @throws ApiError
     */
    public static postPackages-:publish({
        packageId,
    }: {
        packageId: string,
    }): CancelablePromise<PackagePublishResponse> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/packages/{packageId}:publish',
            path: {
                'packageId': packageId,
            },
        });
    }
}
