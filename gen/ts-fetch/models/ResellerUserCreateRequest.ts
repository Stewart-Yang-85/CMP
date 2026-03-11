/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type ResellerUserCreateRequest = {
    email: string;
    displayName: string;
    role: 'reseller_admin' | 'reseller_sales_director' | 'reseller_sales' | 'reseller_finance';
    assignedEnterpriseIds?: Array<string>;
};

