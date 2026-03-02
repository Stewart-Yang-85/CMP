/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type SimCard = {
    /**
     * Integrated Circuit Card Identifier (Physical ID)
     */
    iccid?: string;
    /**
     * International Mobile Subscriber Identity (Network ID)
     */
    imsi?: string;
    /**
     * Mobile Station International Subscriber Directory Number
     */
    msisdn?: string;
    /**
     * Lifecycle state of the SIM
     */
    status?: 'INVENTORY' | 'TEST_READY' | 'ACTIVATED' | 'DEACTIVATED' | 'RETIRED';
    apn?: string;
    planName?: string;
    activationDate?: string;
    /**
     * Whether the SIM is locked to a specific device IMEI
     */
    imeiLocked?: boolean;
};

