export type NearErrorCode = "RPC" | "RHEA" | "TX";

/** Every refusal in this package throws NearError with a stable code. */
export class NearError extends Error {
  readonly code: NearErrorCode;
  constructor(code: NearErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}
