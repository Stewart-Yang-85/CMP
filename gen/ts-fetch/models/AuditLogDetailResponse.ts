/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type AuditLogDetailResponse = {
    auditId?: string;
    actorUserId?: string | null;
    actorRole?: string;
    tenantId?: string | null;
    action?: string;
    targetType?: string;
    targetId?: string;
    requestId?: string;
    createdAt?: string;
    sourceIp?: string | null;
    afterData?: Record<string, any>;
};

