/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class PackagesService {
    /**
     * List Package Versions
     * Lists package versions accessible to the calling enterprise.
     * @returns any Package versions
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
    }): CancelablePromise<{
        items?: Array<{
            packageVersionId?: string;
            packageId?: string;
            packageName?: string | null;
            carrierId?: string | null;
            carrierName?: string | null;
            mcc?: string | null;
            mnc?: string | null;
            status?: string;
            effectiveFrom?: string | null;
            serviceType?: string;
            apn?: string | null;
        }>;
        total?: number;
    }> {
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
     * @returns any Packages
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
    }): CancelablePromise<{
        items?: Array<{
            packageId?: string;
            name?: string;
        }>;
        total?: number;
    }> {
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
}
