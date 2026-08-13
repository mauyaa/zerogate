export type ErrorCode =
  | "INVALID_CANONICAL_JSON"
  | "INVALID_STATE_TRANSITION"
  | "STALE_WITNESS"
  | "APPROVAL_MISMATCH"
  | "APPROVAL_EXPIRED"
  | "APPROVAL_REPLAYED"
  | "PROVIDER_TIMEOUT_AFTER_DISPATCH"
  | "PROVIDER_SAFE_TO_RETRY"
  | "PROVIDER_REJECTED"
  | "PROVIDER_CREDENTIAL_REVOKED"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_SCHEMA_DRIFT"
  | "VERIFICATION_FAILED"
  | "OUTCOME_UNRESOLVED"
  | "COMPENSATION_BLOCKED"
  | "RECOVERY_VERIFICATION_FAILED"
  | "LEDGER_CONFLICT"
  | "LEDGER_INTEGRITY_FAILED"
  /** An effect definition threw something that is not a provider outcome. */
  | "ADAPTER_FAILED"
  | "UNSUPPORTED";

export class ZeroGateError extends Error {
  public constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly details: Readonly<Record<string, unknown>> = {}
  ) {
    super(message);
    this.name = "ZeroGateError";
  }
}

export class ProviderTimeoutAfterDispatchError extends ZeroGateError {
  public constructor(message = "Provider outcome is unknown after request dispatch") {
    super("PROVIDER_TIMEOUT_AFTER_DISPATCH", message, false);
  }
}

export class ProviderSafeToRetryError extends ZeroGateError {
  public constructor(message = "Provider confirms request was not dispatched") {
    super("PROVIDER_SAFE_TO_RETRY", message, true);
  }
}
