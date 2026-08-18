-- Rename vendor-specific inbound event type to platform-neutral INBOUND_* (any upstream adapter).

UPDATE public.events
SET event_type = 'INBOUND_SIM_STATUS_CHANGED'
WHERE event_type = 'WX_SIM_STATUS_CHANGED';
