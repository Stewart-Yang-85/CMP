-- Fix create_customer RPC after T137 (20260324100001): customers.reseller_tenant_id is NOT NULL.
-- Greenfield (CMP3): without this, INSERT in create_customer fails after identity unification.
--
-- Also scope name uniqueness by reseller_tenant_id (matches uq_customers_reseller_tenant_name).

CREATE OR REPLACE FUNCTION create_customer(
  p_reseller_id uuid,
  p_name text,
  p_auto_suspend_enabled boolean DEFAULT true,
  p_created_by uuid DEFAULT NULL
)
RETURNS jsonb AS $$
DECLARE
  v_tenant_id uuid;
  v_customer_id uuid;
  v_reseller_tenant_id uuid;
BEGIN
  IF p_name IS NULL OR trim(p_name) = '' THEN
    RAISE EXCEPTION 'customer name is required' USING errcode = 'P0001';
  END IF;

  SELECT tenant_id INTO v_reseller_tenant_id
  FROM resellers
  WHERE id = p_reseller_id AND status != 'DEACTIVATED';

  IF v_reseller_tenant_id IS NULL THEN
    RAISE EXCEPTION 'reseller not found or deactivated: %', p_reseller_id USING errcode = 'P0002';
  END IF;

  IF EXISTS (
    SELECT 1 FROM customers
    WHERE reseller_tenant_id = v_reseller_tenant_id AND name = trim(p_name)
  ) THEN
    RAISE EXCEPTION 'customer name already exists under this reseller: %', p_name USING errcode = '23505';
  END IF;

  INSERT INTO tenants (parent_id, tenant_type, name, enterprise_status, auto_suspend_enabled)
  VALUES (v_reseller_tenant_id, 'ENTERPRISE', trim(p_name), 'ACTIVE', p_auto_suspend_enabled)
  RETURNING tenant_id INTO v_tenant_id;

  INSERT INTO customers (
    tenant_id,
    reseller_id,
    reseller_tenant_id,
    name,
    status,
    auto_suspend_enabled,
    created_by
  )
  VALUES (
    v_tenant_id,
    p_reseller_id,
    v_reseller_tenant_id,
    trim(p_name),
    'ACTIVE',
    p_auto_suspend_enabled,
    p_created_by
  )
  RETURNING id INTO v_customer_id;

  RETURN jsonb_build_object(
    'tenant_id', v_tenant_id,
    'customer_id', v_customer_id,
    'reseller_id', p_reseller_id,
    'reseller_tenant_id', v_reseller_tenant_id,
    'name', trim(p_name),
    'status', 'ACTIVE'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
