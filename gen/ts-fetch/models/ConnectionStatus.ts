/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type ConnectionStatus = {
    iccid?: string;
    onlineStatus?: 'ONLINE' | 'OFFLINE';
    registrationStatus?: 'REGISTERED_HOME' | 'REGISTERED_ROAMING' | 'NOT_REGISTERED' | 'DENIED';
    lastActiveTime?: string;
    ipAddress?: string;
    /**
     * Radio Access Technology
     */
    ratType?: string;
    /**
     * Cell ID of the current base station
     */
    servingCellId?: string;
};

