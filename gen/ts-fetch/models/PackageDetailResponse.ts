/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { PackageVersion } from './PackageVersion';
export type PackageDetailResponse = {
    packageId?: string;
    enterpriseId?: string;
    name?: string;
    createdAt?: string;
    currentVersion?: PackageVersion;
    versions?: Array<PackageVersion>;
};

