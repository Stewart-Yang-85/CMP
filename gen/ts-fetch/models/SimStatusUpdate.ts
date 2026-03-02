/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type SimStatusUpdate = {
    /**
     * The target status to transition to.
     */
    status: 'ACTIVATED' | 'DEACTIVATED';
    /**
     * Reason for the status change (e.g., "Customer Request", "Stolen").
     */
    reason?: string;
};

