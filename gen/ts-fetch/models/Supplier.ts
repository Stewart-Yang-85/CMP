/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { SupplierBoundOperator } from './SupplierBoundOperator';
export type Supplier = {
    supplierId?: string;
    name?: string;
    status?: 'ACTIVE' | 'SUSPENDED';
    createdAt?: string;
    operatorIds?: Array<string> | null;
    operators?: Array<SupplierBoundOperator> | null;
};

