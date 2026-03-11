/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ProfileVersion } from './ProfileVersion';
export type ApnProfileDetailResponse = {
    apnProfileId?: string;
    name?: string;
    apn?: string;
    authType?: string;
    username?: string;
    passwordRef?: string;
    supplierId?: string;
    operatorId?: string;
    status?: string;
    createdAt?: string;
    updatedAt?: string;
    currentVersion?: ProfileVersion;
    versions?: Array<ProfileVersion>;
};

