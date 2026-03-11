/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type AuditLogItem = {
    auditId?: number;
    actorUserId?: string | null;
    actorRole?: string;
    tenantId?: string | null;
    action?: string;
    targetType?: string;
    targetId?: string;
    requestId?: string;
    sourceIp?: string;
    createdAt?: string;
};

