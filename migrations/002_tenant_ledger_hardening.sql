BEGIN;

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS policy_version text NOT NULL DEFAULT 'policy.legacy';

ALTER TABLE ledger_events ADD COLUMN IF NOT EXISTS tenant_id text;
UPDATE ledger_events AS event
SET tenant_id = COALESCE(
  (
    SELECT transaction.tenant_id
    FROM transactions AS transaction
    WHERE transaction.transaction_id::text = event.subject
  ),
  'tenant_legacy'
)
WHERE event.tenant_id IS NULL;
ALTER TABLE ledger_events ALTER COLUMN tenant_id SET NOT NULL;

-- Migration 001 predated tenancy and therefore imposed global event uniqueness.
-- Remove those constraints before replacing them with tenant-scoped indexes.
ALTER TABLE ledger_events
  DROP CONSTRAINT IF EXISTS ledger_events_event_id_key,
  DROP CONSTRAINT IF EXISTS ledger_events_event_hash_key,
  DROP CONSTRAINT IF EXISTS ledger_events_subject_subject_sequence_key;

ALTER TABLE receipts ADD COLUMN IF NOT EXISTS tenant_id text;
UPDATE receipts AS receipt
SET tenant_id = transaction.tenant_id
FROM transactions AS transaction
WHERE receipt.transaction_id = transaction.transaction_id
  AND receipt.tenant_id IS NULL;
ALTER TABLE receipts ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE actions ADD COLUMN IF NOT EXISTS tenant_id text;
UPDATE actions AS action
SET tenant_id = transaction.tenant_id
FROM transactions AS transaction
WHERE action.transaction_id = transaction.transaction_id
  AND action.tenant_id IS NULL;
ALTER TABLE actions ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE actions
  DROP CONSTRAINT IF EXISTS actions_logical_operation_id_key;

ALTER TABLE state_witnesses ADD COLUMN IF NOT EXISTS tenant_id text;
UPDATE state_witnesses AS witness
SET tenant_id = action.tenant_id
FROM actions AS action
WHERE witness.action_id = action.action_id
  AND witness.tenant_id IS NULL;
ALTER TABLE state_witnesses ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE attempts ADD COLUMN IF NOT EXISTS tenant_id text;
UPDATE attempts AS attempt
SET tenant_id = action.tenant_id
FROM actions AS action
WHERE attempt.action_id = action.action_id
  AND attempt.tenant_id IS NULL;
ALTER TABLE attempts ALTER COLUMN tenant_id SET NOT NULL;

CREATE TABLE IF NOT EXISTS ledger_chain_heads (
  tenant_id text NOT NULL,
  subject text NOT NULL,
  last_sequence bigint NOT NULL CHECK (last_sequence >= 1),
  last_hash text NOT NULL CHECK (last_hash ~ '^[a-f0-9]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, subject)
);

INSERT INTO ledger_chain_heads(tenant_id, subject, last_sequence, last_hash, updated_at)
SELECT DISTINCT ON (tenant_id, subject)
  tenant_id,
  subject,
  subject_sequence,
  event_hash,
  event_time
FROM ledger_events
ORDER BY tenant_id, subject, subject_sequence DESC
ON CONFLICT (tenant_id, subject) DO NOTHING;

CREATE TABLE IF NOT EXISTS approval_mandates (
  approval_id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  transaction_id uuid NOT NULL REFERENCES transactions(transaction_id),
  nonce uuid NOT NULL,
  claims jsonb NOT NULL CHECK (jsonb_typeof(claims) = 'object'),
  key_id text NOT NULL,
  signature text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, nonce)
);

CREATE TABLE IF NOT EXISTS logical_operation_registry (
  tenant_id text NOT NULL,
  logical_operation_id text NOT NULL,
  action_id uuid NOT NULL REFERENCES actions(action_id),
  payload_hash text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN (
    'DISPATCHING', 'OUTCOME_UNKNOWN', 'COMMITTED', 'REJECTED', 'RECONCILING'
  )),
  provider_request_id text,
  provider_evidence jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, logical_operation_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS transactions_tenant_transaction_uidx
  ON transactions(tenant_id, transaction_id);
CREATE UNIQUE INDEX IF NOT EXISTS actions_tenant_action_uidx
  ON actions(tenant_id, action_id);
CREATE UNIQUE INDEX IF NOT EXISTS actions_tenant_logical_operation_uidx
  ON actions(tenant_id, logical_operation_id);
CREATE INDEX IF NOT EXISTS actions_tenant_transaction_idx
  ON actions(tenant_id, transaction_id);
CREATE INDEX IF NOT EXISTS attempts_tenant_action_idx
  ON attempts(tenant_id, action_id);
CREATE INDEX IF NOT EXISTS ledger_events_tenant_subject_idx
  ON ledger_events(tenant_id, subject, subject_sequence);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_events_tenant_event_uidx
  ON ledger_events(tenant_id, event_id);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_events_tenant_hash_uidx
  ON ledger_events(tenant_id, event_hash);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_events_tenant_subject_sequence_uidx
  ON ledger_events(tenant_id, subject, subject_sequence);
CREATE UNIQUE INDEX IF NOT EXISTS receipts_tenant_transaction_uidx
  ON receipts(tenant_id, transaction_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'actions_tenant_transaction_fk') THEN
    ALTER TABLE actions
      ADD CONSTRAINT actions_tenant_transaction_fk
      FOREIGN KEY (tenant_id, transaction_id)
      REFERENCES transactions(tenant_id, transaction_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'receipts_tenant_transaction_fk') THEN
    ALTER TABLE receipts
      ADD CONSTRAINT receipts_tenant_transaction_fk
      FOREIGN KEY (tenant_id, transaction_id)
      REFERENCES transactions(tenant_id, transaction_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'approval_mandates_tenant_transaction_fk') THEN
    ALTER TABLE approval_mandates
      ADD CONSTRAINT approval_mandates_tenant_transaction_fk
      FOREIGN KEY (tenant_id, transaction_id)
      REFERENCES transactions(tenant_id, transaction_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attempts_tenant_action_fk') THEN
    ALTER TABLE attempts
      ADD CONSTRAINT attempts_tenant_action_fk
      FOREIGN KEY (tenant_id, action_id)
      REFERENCES actions(tenant_id, action_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'state_witnesses_tenant_action_fk') THEN
    ALTER TABLE state_witnesses
      ADD CONSTRAINT state_witnesses_tenant_action_fk
      FOREIGN KEY (tenant_id, action_id)
      REFERENCES actions(tenant_id, action_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'logical_operation_registry_tenant_action_fk') THEN
    ALTER TABLE logical_operation_registry
      ADD CONSTRAINT logical_operation_registry_tenant_action_fk
      FOREIGN KEY (tenant_id, action_id)
      REFERENCES actions(tenant_id, action_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ledger_events_subject_sequence_check') THEN
    ALTER TABLE ledger_events
      ADD CONSTRAINT ledger_events_subject_sequence_check
      CHECK (subject_sequence >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ledger_events_previous_hash_check') THEN
    ALTER TABLE ledger_events
      ADD CONSTRAINT ledger_events_previous_hash_check
      CHECK (previous_hash = 'GENESIS' OR previous_hash ~ '^[a-f0-9]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ledger_events_event_hash_check') THEN
    ALTER TABLE ledger_events
      ADD CONSTRAINT ledger_events_event_hash_check
      CHECK (event_hash ~ '^[a-f0-9]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ledger_events_data_object_check') THEN
    ALTER TABLE ledger_events
      ADD CONSTRAINT ledger_events_data_object_check
      CHECK (jsonb_typeof(data) = 'object');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION zerogate_reject_immutable_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; write a superseding event instead', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS ledger_events_immutable ON ledger_events;
CREATE TRIGGER ledger_events_immutable
BEFORE UPDATE OR DELETE ON ledger_events
FOR EACH ROW EXECUTE FUNCTION zerogate_reject_immutable_mutation();

DROP TRIGGER IF EXISTS ledger_events_truncate_immutable ON ledger_events;
CREATE TRIGGER ledger_events_truncate_immutable
BEFORE TRUNCATE ON ledger_events
FOR EACH STATEMENT EXECUTE FUNCTION zerogate_reject_immutable_mutation();

DROP TRIGGER IF EXISTS receipts_immutable ON receipts;
CREATE TRIGGER receipts_immutable
BEFORE UPDATE OR DELETE ON receipts
FOR EACH ROW EXECUTE FUNCTION zerogate_reject_immutable_mutation();

DROP TRIGGER IF EXISTS receipts_truncate_immutable ON receipts;
CREATE TRIGGER receipts_truncate_immutable
BEFORE TRUNCATE ON receipts
FOR EACH STATEMENT EXECUTE FUNCTION zerogate_reject_immutable_mutation();

ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions FORCE ROW LEVEL SECURITY;
ALTER TABLE actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE actions FORCE ROW LEVEL SECURITY;
ALTER TABLE state_witnesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE state_witnesses FORCE ROW LEVEL SECURITY;
ALTER TABLE attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_events FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger_chain_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_chain_heads FORCE ROW LEVEL SECURITY;
ALTER TABLE approval_mandates ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_mandates FORCE ROW LEVEL SECURITY;
ALTER TABLE logical_operation_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE logical_operation_registry FORCE ROW LEVEL SECURITY;
ALTER TABLE receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE receipts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON transactions;
CREATE POLICY tenant_isolation ON transactions
  USING (tenant_id = (SELECT nullif(current_setting('zerogate.tenant_id', true), '')))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('zerogate.tenant_id', true), '')));
DROP POLICY IF EXISTS tenant_isolation ON actions;
CREATE POLICY tenant_isolation ON actions
  USING (tenant_id = (SELECT nullif(current_setting('zerogate.tenant_id', true), '')))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('zerogate.tenant_id', true), '')));
DROP POLICY IF EXISTS tenant_isolation ON state_witnesses;
CREATE POLICY tenant_isolation ON state_witnesses
  USING (tenant_id = (SELECT nullif(current_setting('zerogate.tenant_id', true), '')))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('zerogate.tenant_id', true), '')));
DROP POLICY IF EXISTS tenant_isolation ON attempts;
CREATE POLICY tenant_isolation ON attempts
  USING (tenant_id = (SELECT nullif(current_setting('zerogate.tenant_id', true), '')))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('zerogate.tenant_id', true), '')));
DROP POLICY IF EXISTS tenant_isolation ON ledger_events;
CREATE POLICY tenant_isolation ON ledger_events
  USING (tenant_id = (SELECT nullif(current_setting('zerogate.tenant_id', true), '')))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('zerogate.tenant_id', true), '')));
DROP POLICY IF EXISTS tenant_isolation ON ledger_chain_heads;
CREATE POLICY tenant_isolation ON ledger_chain_heads
  USING (tenant_id = (SELECT nullif(current_setting('zerogate.tenant_id', true), '')))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('zerogate.tenant_id', true), '')));
DROP POLICY IF EXISTS tenant_isolation ON approval_mandates;
CREATE POLICY tenant_isolation ON approval_mandates
  USING (tenant_id = (SELECT nullif(current_setting('zerogate.tenant_id', true), '')))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('zerogate.tenant_id', true), '')));
DROP POLICY IF EXISTS tenant_isolation ON logical_operation_registry;
CREATE POLICY tenant_isolation ON logical_operation_registry
  USING (tenant_id = (SELECT nullif(current_setting('zerogate.tenant_id', true), '')))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('zerogate.tenant_id', true), '')));
DROP POLICY IF EXISTS tenant_isolation ON receipts;
CREATE POLICY tenant_isolation ON receipts
  USING (tenant_id = (SELECT nullif(current_setting('zerogate.tenant_id', true), '')))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('zerogate.tenant_id', true), '')));

INSERT INTO zerogate_schema_migrations(version)
VALUES ('002_tenant_ledger_hardening')
ON CONFLICT (version) DO NOTHING;

COMMIT;
