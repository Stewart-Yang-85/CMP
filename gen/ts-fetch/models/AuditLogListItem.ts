/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type AuditLogListItem = {
    logId?: string;
    actor?: string | null;
    actorRole?: string | null;
    tenantScope?: string | null;
    action?: string;
    target?: string | null;
    before?: Record<string, any> | null;
    after?: Record<string, any> | null;
    requestId?: string | null;
    timestamp?: string;
    sourceIp?: string | null;
};

