// Sealed-box delivery of the rules key (D57). crypto_box_seal = X25519 + XSalsa20-Poly1305,
// via libsodium. Pure: no clock, network or state; randomness only inside libsodium's seal.
import sodium from "libsodium-wrappers";

export const KEY_BYTES = 32;
export const SEALED_BYTES = 80; // 32 key + 32 ephemeral pk + 16 tag
export const SEALED_HEX_LEN = SEALED_BYTES * 2;

export interface KeyPair {
  publicKey: string; // 64 lowercase hex
  privateKey: string; // 64 lowercase hex
}

export function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function fromHex(h: string): Uint8Array {
  if (h.length % 2 !== 0 || !/^[0-9a-f]*$/.test(h)) throw new Error("SEAL: bad hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function generateKeyPair(): Promise<KeyPair> {
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  return { publicKey: toHex(kp.publicKey), privateKey: toHex(kp.privateKey) };
}

export async function sealKey(key: Uint8Array, buyerPublicKeyHex: string): Promise<string> {
  if (key.length !== KEY_BYTES) throw new Error("SEAL: key must be 32 bytes");
  if (!/^[0-9a-f]{64}$/.test(buyerPublicKeyHex) || /^0+$/.test(buyerPublicKeyHex)) {
    throw new Error("SEAL: buyer key must be 64 lowercase hex and not all zero");
  }
  return toHex(await seal(fromHex(buyerPublicKeyHex), key));
}

export async function openKey(sealedHex: string, pair: KeyPair): Promise<Uint8Array> {
  if (!/^[0-9a-f]{160}$/.test(sealedHex)) throw new Error("SEAL: sealed key must be 160 lowercase hex");
  if (!/^[0-9a-f]{64}$/.test(pair.publicKey) || !/^[0-9a-f]{64}$/.test(pair.privateKey)) {
    throw new Error("SEAL: bad key pair");
  }
  await sodium.ready;
  try {
    return sodium.crypto_box_seal_open(fromHex(sealedHex), fromHex(pair.publicKey), fromHex(pair.privateKey));
  } catch {
    throw new Error("SEAL: cannot open");
  }
}

// Byte-level API agreed with the lead (frontend codes against these). Async because libsodium inits lazily.
export interface RawKeypair { pk: Uint8Array; sk: Uint8Array }

export async function generateKeypair(): Promise<RawKeypair> {
  await sodium.ready;
  const kp = sodium.crypto_box_keypair();
  return { pk: kp.publicKey, sk: kp.privateKey };
}

export async function seal(recipientPk: Uint8Array, msg: Uint8Array): Promise<Uint8Array> {
  if (recipientPk.length !== 32 || recipientPk.every((b) => b === 0)) throw new Error("SEAL: buyer key must be 32 bytes and not all zero");
  await sodium.ready;
  try {
    return sodium.crypto_box_seal(msg, recipientPk);
  } catch {
    // libsodium refuses a low-order point (shared secret of all zeros).
    throw new Error("SEAL: unusable buyer key");
  }
}

/** Throws on any failure (wrong key, tampering, truncation). */
export async function open(recipientPk: Uint8Array, recipientSk: Uint8Array, ct: Uint8Array): Promise<Uint8Array> {
  await sodium.ready;
  try {
    return sodium.crypto_box_seal_open(ct, recipientPk, recipientSk);
  } catch {
    throw new Error("SEAL: cannot open");
  }
}
