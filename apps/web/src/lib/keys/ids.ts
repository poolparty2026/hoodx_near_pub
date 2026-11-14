// Account-id and key shape checks for the testnet-only follow flow.
/** A NEAR testnet account id: 2..64 characters, parts of [a-z0-9] joined by single '.', '-' or '_', ending in ".testnet". */
export const isTestnetId = (id: string): boolean => id.length >= 9 && id.length <= 64 && /^(?:[a-z0-9]+[._-])*[a-z0-9]+\.testnet$/.test(id);

/** An ed25519 secret key as NEAR prints it: "ed25519:" and base58 of 64 bytes (86 to 88 characters). A shape check only. */
export const looksLikeSecretKey = (k: string): boolean => /^ed25519:[1-9A-HJ-NP-Za-km-z]{86,88}$/.test(k);
