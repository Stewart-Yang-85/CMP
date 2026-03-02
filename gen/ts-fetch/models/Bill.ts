/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type Bill = {
    billId?: string;
    enterpriseId?: string;
    period?: string;
    status?: 'GENERATED' | 'PUBLISHED' | 'PAID' | 'OVERDUE' | 'WRITTEN_OFF';
    currency?: string;
    totalAmount?: number;
    dueDate?: string;
};

