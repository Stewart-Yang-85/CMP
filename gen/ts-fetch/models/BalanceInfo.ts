/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type BalanceInfo = {
    currency?: string;
    /**
     * Monetary balance for prepaid accounts.
     */
    accountBalance?: number;
    /**
     * Remaining data quota in bytes.
     */
    dataBalanceBytes?: number;
    /**
     * Remaining SMS quota.
     */
    smsBalanceCount?: number;
};

