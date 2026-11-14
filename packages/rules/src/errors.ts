/** Every refusal in this package throws RulesError with a stable code. */
export type RulesErrorCode =
  | "JSON_SYNTAX"
  | "JSON_DUPLICATE_KEY"
  | "JSON_NUMBER"
  | "CANON_VALUE"
  | "SCHEMA"
  | "CRYPTO"
  | "HASH_MISMATCH"
  | "STATE";

export class RulesError extends Error {
  readonly code: RulesErrorCode;
  constructor(code: RulesErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = "RulesError";
  }
}
