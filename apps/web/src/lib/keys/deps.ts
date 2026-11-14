import * as seal from "@poolside/seal";
import type { BuyerKeyPair, SealedBox } from "./flow.ts";

/** The real sealed box: packages/seal (libsodium crypto_box_seal, D57-a). */
export const sealedBox: SealedBox = {
  generateKeyPair: async (): Promise<BuyerKeyPair> => { const k = await seal.generateKeypair(); return { publicKey: k.pk, secretKey: k.sk }; },
  seal: seal.seal,
  open: seal.open,
};

