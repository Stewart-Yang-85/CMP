-- Phase 41a: bill_status enum must commit before VOIDED can appear in indexes/constraints.
-- PostgreSQL 55P04: unsafe use of new enum value in the same transaction.

ALTER TYPE bill_status ADD VALUE IF NOT EXISTS 'VOIDED';
