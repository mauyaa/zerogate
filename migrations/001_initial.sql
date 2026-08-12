BEGIN;

CREATE TABLE IF NOT EXISTS zerogate_schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transactions (
  transaction_id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  state text NOT NULL,
  intent jsonb NOT NULL,
  limits_hash text NOT NULL,
  action_set_root text NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (state IN (
    'DRAFT','PREFLIGHTING','PREFLIGHT_FAILED','READY','AWAITING_APPROVAL','APPROVAL_DENIED',
    'COMMIT_REQUESTED','COMMITTING','VERIFYING','RELEASING','VERIFIED_COMMITTED',
    'FAILURE_DETECTED','RECONCILING','COMPENSATING','VERIFYING_RECOVERY',
    'VERIFIED_COMPENSATED','PARTIALLY_COMPENSATED','MANUAL_RECOVERY_REQUIRED','ABORTED','EXPIRED'
  ))
);

CREATE TABLE IF NOT EXISTS actions (
  action_id uuid PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES transactions(transaction_id),
  operation text NOT NULL,
  state text NOT NULL,
  logical_operation_id text NOT NULL UNIQUE,
  payload_hash text NOT NULL,
  contract_digest text NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS state_witnesses (
  witness_id uuid PRIMARY KEY,
  action_id uuid NOT NULL REFERENCES actions(action_id),
  provider_version text NOT NULL,
  state_hash text NOT NULL,
  strength text NOT NULL,
  observed_at timestamptz NOT NULL,
  encrypted_state bytea,
  redacted_state jsonb,
  UNIQUE (action_id, provider_version, state_hash)
);

CREATE TABLE IF NOT EXISTS attempts (
  attempt_id uuid PRIMARY KEY,
  action_id uuid NOT NULL REFERENCES actions(action_id),
  logical_operation_id text NOT NULL,
  kind text NOT NULL,
  classification text,
  provider_request_id text,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (logical_operation_id, attempt_id)
);

CREATE TABLE IF NOT EXISTS ledger_events (
  global_sequence bigserial PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE,
  subject text NOT NULL,
  subject_sequence bigint NOT NULL,
  source text NOT NULL,
  event_type text NOT NULL,
  event_time timestamptz NOT NULL,
  correlation_id text,
  causation_id text,
  traceparent text,
  data jsonb NOT NULL,
  previous_hash text NOT NULL,
  event_hash text NOT NULL UNIQUE,
  UNIQUE (subject, subject_sequence)
);

CREATE INDEX IF NOT EXISTS ledger_events_subject_idx ON ledger_events(subject, subject_sequence);
CREATE INDEX IF NOT EXISTS ledger_events_correlation_idx ON ledger_events(correlation_id);

CREATE TABLE IF NOT EXISTS receipts (
  receipt_id uuid PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES transactions(transaction_id),
  body jsonb NOT NULL,
  key_id text NOT NULL,
  signature text NOT NULL,
  event_chain_root text NOT NULL,
  issued_at timestamptz NOT NULL
);

INSERT INTO zerogate_schema_migrations(version)
VALUES ('001_initial')
ON CONFLICT (version) DO NOTHING;

COMMIT;
