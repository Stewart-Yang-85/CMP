# Runbook: Phase 30 T228 — Covered / roaming billing indexes & EXPLAIN

**Feature**: `iot-cmp-reseller` | **Task**: T228  
**Scope**: `covered_network_profile_entries`, `roaming_profiles` (batch fetch used by `computeMonthlyCharges` in `src/billing.js`).

## 1. Uniqueness (covered rows)

`covered_network_profile_entries` must enforce **one row per (profile, mcc, mnc)**:

- Constraint: `covered_network_profile_entries_mcc_mnc_unique` on `(covered_network_profile_id, mcc, mnc)` (created in `20260422100007_covered_network_profiles.sql`).
- **Note**: Logical “profile id” in spec text maps to column `covered_network_profile_id` (not `profile_id`).

Verify:

```sql
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'public.covered_network_profile_entries'::regclass
  AND contype = 'u';
```

## 2. Roaming shape (no `roaming_profile_entries` table)

OOP roaming in billing loads **`roaming_profiles`** by **`roaming_profile_id IN (...)`** and reads **`mccmnc_list`** (jsonb) on each row. There is **no** normalized `roaming_profile_entries` table in this repo; PK on `roaming_profile_id` is the index for the batch id list.

## 3. EXPLAIN acceptance (~600 rows / covered profile)

On a database with **representative volume** (e.g. one covered profile with ~600 `(mcc,mnc)` rows, and a handful of ids in the `IN` list), run:

**Covered entries (matches PostgREST-style filter):**

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT covered_network_profile_id, mcc, mnc
FROM public.covered_network_profile_entries
WHERE covered_network_profile_id IN (
  '00000000-0000-0000-0000-000000000001'::uuid
);
```

**Acceptance**: expect **Index Scan** or **Bitmap Index Scan** on `covered_network_profile_entries_mcc_mnc_unique` (or equivalent index on leading column **not** **Seq Scan** on a large table). On tiny dev datasets PostgreSQL may still choose **Seq Scan**; treat **Seq Scan** as a **regression** only when `EXPLAIN` shows large row counts / high cost on production-like sizes.

**Roaming profiles:**

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT roaming_profile_id, mccmnc_list
FROM public.roaming_profiles
WHERE roaming_profile_id IN (
  '00000000-0000-0000-0000-000000000002'::uuid
);
```

**Acceptance**: **Index Scan** using **PK** on `roaming_profile_id` (not a sequential scan of the whole table at scale).

## 4. Statistics

Migration `20260422100009_phase30_billing_entry_indexes.sql` runs **`ANALYZE`** on both tables so the planner stays aligned after bulk loads.

## 5. Scale note

Target **~600 rows per CoveredNetworkProfile** is a product/design guideline for in-profile rating; indexing supports that volume per batch `IN` list of profile ids.
