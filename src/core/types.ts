export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type TransactionState =
  | "DRAFT"
  | "PREFLIGHTING"
  | "PREFLIGHT_FAILED"
  | "READY"
  | "AWAITING_APPROVAL"
  | "APPROVAL_DENIED"
  | "COMMIT_REQUESTED"
  | "COMMITTING"
  | "VERIFYING"
  | "RELEASING"
  | "VERIFIED_COMMITTED"
  | "FAILURE_DETECTED"
  | "RECONCILING"
  | "COMPENSATING"
  | "VERIFYING_RECOVERY"
  | "VERIFIED_COMPENSATED"
  | "PARTIALLY_COMPENSATED"
  | "MANUAL_RECOVERY_REQUIRED"
  | "ABORTED"
  | "EXPIRED";

export type ActionState =
  | "PROPOSED"
  | "PREFLIGHTING"
  | "PREFLIGHT_REJECTED"
  | "PREFLIGHTED"
  | "AWAITING_APPROVAL"
  | "ADMITTED"
  | "SCHEDULED"
  | "DISPATCHING"
  | "OUTCOME_UNKNOWN"
  | "RECONCILING"
  | "PROVIDER_REJECTED"
  | "REPORTED_SUCCEEDED"
  | "VERIFYING"
  | "VERIFIED_SUCCEEDED"
  | "VERIFICATION_FAILED"
  | "DRIFTED"
  | "COMPENSATION_PLANNED"
  | "COMPENSATING"
  | "COMPENSATION_UNKNOWN"
  | "COMPENSATION_RECONCILING"
  | "COMPENSATION_REPORTED_SUCCEEDED"
  | "COMPENSATION_VERIFYING"
  | "VERIFIED_COMPENSATED"
  | "COMPENSATION_BLOCKED"
  | "COMPENSATION_FAILED"
  | "WITHHELD"
  | "RELEASING"
  | "VERIFIED_RELEASED"
  | "CANCELLED";

export type Finality = "VERIFIED" | "PROVIDER_ATTESTED" | "INFERRED" | "UNKNOWN" | "DISPUTED";

export type OutcomeClassification =
  | "DEFINITIVE_SUCCESS"
  | "DEFINITIVE_REJECTION"
  | "SAFE_TO_RETRY"
  | "OUTCOME_UNKNOWN"
  | "PROVIDER_INCONSISTENT"
  | "CONTRACT_VIOLATION";

export interface Actor {
  principalId: string;
  agentId: string;
  agentVersion: string;
  workloadId?: string;
  delegationChain?: string[];
}

export interface ResourceScope {
  type: string;
  id: string;
  constraints?: Record<string, JsonValue>;
}

export interface IntentLimits {
  maxActions: number;
  maxExternalMessages?: number;
  maxRuntimeSeconds?: number;
}

export interface IntentEnvelope {
  schemaVersion: "1.0";
  tenantId: string;
  environment: "development" | "test" | "staging" | "production";
  actor: Actor;
  purpose: string;
  resourceScope: ResourceScope[];
  limits: IntentLimits;
  expiresAt: string;
}

export interface MaterialDiff {
  field: string;
  before: JsonValue | undefined;
  after: JsonValue | undefined;
}

export interface StateWitness<TState> {
  observedAt: string;
  providerVersion: string;
  stateHash: string;
  strength: "strong" | "medium" | "weak" | "none";
  state: TState;
}

export interface DispatchEvidence<TProviderResult> {
  providerRequestId?: string;
  logicalOperationId: string;
  attemptId: string;
  result?: TProviderResult;
  classification: OutcomeClassification;
  observedAt: string;
  message?: string;
}

export interface Verification<TObserved> {
  ok: boolean;
  observed: TObserved;
  finality: Finality;
  reason?: string;
}

export interface Reconciliation<TObserved> {
  resolved: boolean;
  committed: boolean;
  observed?: TObserved;
  finality: Finality;
  reason: string;
  /**
   * Provider request IDs recovered from provider-side evidence during
   * reconciliation. These prove which attempt actually committed.
   */
  providerRequestIds?: readonly string[];
}

export interface RecoveryPlan<TRecovery> {
  safe: boolean;
  reason: string;
  payload?: TRecovery;
}

export interface ActionRuntimeRecord {
  actionId: string;
  transactionId: string;
  operation: string;
  logicalOperationId: string;
  payloadHash: string;
  contractDigest: string;
  state: ActionState;
  attempts: string[];
  observations: Array<Record<string, JsonValue>>;
  residualRisk: string[];
}

export interface TransactionRuntimeRecord {
  transactionId: string;
  state: TransactionState;
  intent: IntentEnvelope;
  limitsHash: string;
  actionSetRoot: string;
  policyVersion: string;
  createdAt: string;
  updatedAt: string;
}

export interface PublicLedgerEvent {
  specversion: "1.0";
  id: string;
  source: string;
  type: string;
  subject: string;
  time: string;
  sequence: number;
  traceparent?: string;
  causationId?: string;
  correlationId?: string;
  datacontenttype: "application/json";
  data: Record<string, JsonValue>;
}

export interface StoredLedgerEvent extends PublicLedgerEvent {
  previousHash: string;
  eventHash: string;
}

export interface ReceiptAction {
  actionId: string;
  operation: string;
  logicalOperationId: string;
  payloadHash: string;
  contractDigest: string;
  status: ActionState;
  finality: Finality;
  attemptIds: string[];
  providerRequestIds: string[];
  observations: Array<Record<string, JsonValue>>;
  recovery?: Record<string, JsonValue>;
  residualRisk: string[];
}

export interface ReceiptBody {
  schemaVersion: "1.0";
  receiptId: string;
  transactionId: string;
  issuedAt: string;
  finalStatus:
    | "VERIFIED_COMMITTED"
    | "VERIFIED_COMPENSATED"
    | "MANUAL_RECOVERY_REQUIRED"
    | "APPROVAL_DENIED"
    | "PREFLIGHT_FAILED"
    | "ABORTED"
    | "EXPIRED";
  finality: Finality;
  intentBinding: {
    tenantId: string;
    environment: IntentEnvelope["environment"];
    actor: Actor;
    purpose: string;
    resourceScope: ResourceScope[];
    expiresAt: string;
    limitsHash: string;
    actionSetRoot: string;
    policyVersion: string;
  };
  actions: ReceiptAction[];
  approvals: Array<Record<string, JsonValue>>;
  manualRecovery: Array<Record<string, JsonValue>>;
}

export interface SignedReceipt extends ReceiptBody {
  integrity: {
    algorithm: "Ed25519";
    keyId: string;
    eventChainRoot: string;
    signature: string;
  };
}
