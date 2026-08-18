-- Rename inbound webhook event_key sim-online -> update-location (no legacy alias).

INSERT INTO upstream_inbound_webhook_events (event_key, display_name, description, sort_order, status)
VALUES (
  'update-location',
  'Update Location',
  'SIM update location (first attach phase; upstream may send SIM_ONLINE or LocationUpdate)',
  20,
  'ACTIVE'
)
ON CONFLICT (event_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  status = 'ACTIVE',
  updated_at = now();

UPDATE upstream_integration_webhook_subscriptions
SET event_key = 'update-location', updated_at = now()
WHERE event_key = 'sim-online';

DELETE FROM upstream_inbound_webhook_events WHERE event_key = 'sim-online';

UPDATE events SET event_type = 'UPDATE_LOCATION' WHERE event_type = 'SIM_ONLINE';
