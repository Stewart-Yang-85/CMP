-- Rename inbound webhook event_key product-order -> subscription (no legacy alias).

INSERT INTO upstream_inbound_webhook_events (event_key, display_name, description, sort_order, status)
VALUES (
  'subscription',
  'Subscription',
  'Upstream subscription / add-on notification (upstream may send ProductChange or ProductOrder)',
  10,
  'ACTIVE'
)
ON CONFLICT (event_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  status = 'ACTIVE',
  updated_at = now();

UPDATE upstream_integration_webhook_subscriptions
SET event_key = 'subscription', updated_at = now()
WHERE event_key = 'product-order';

DELETE FROM upstream_inbound_webhook_events WHERE event_key = 'product-order';

UPDATE events SET event_type = 'SUBSCRIPTION' WHERE event_type = 'PRODUCT_ORDERED';

UPDATE audit_logs SET action = 'WX_WEBHOOK_SUBSCRIPTION' WHERE action = 'WX_WEBHOOK_PRODUCT_ORDERED';
