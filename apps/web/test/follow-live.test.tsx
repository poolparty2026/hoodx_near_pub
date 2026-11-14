// @vitest-environment jsdom
// Component tests: FollowLive is rendered in a DOM and driven like a person would. The chain and the wallet are mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { hashRules, parseRules, toHex } from "@poolside/rules";
import { parseKeyParams, parseKeySale } from "../src/lib/keys/views.ts";

vi.setConfig({ testTimeout: 30_000 }); // libsodium and jsdom tests pass in about 1 s but can take over 5 s under coverage; the default stays for every other file
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STRAT = "strategy.fixture.testnet";
const TESTNET_SECRET = "ed25519:" + "TESTSECRETDNTLEAK".padEnd(87, "z"); // right shape, throwaway
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const RULES = parseRules(JSON.stringify({ version: 1, pool: `${USDC}|wrap.near|100`, quote_token: USDC, range: { width_bps: 800, centre: "mid" }, take_profit_bps: 300, stop_loss_bps: 1000, close_after_s: 432000, salt: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }));
const PARAMS = parseKeyParams({ key_price: "1000", key_delivery_window_ns: "3600000000000", max_key_sales: 5, sold: 0, deliverer: "d.testnet", escrow_total: "0", near_owed_total: "0" });

const m = vi.hoisted(() => ({
  loadFollow: vi.fn(), buyViewingKey: vi.fn(), refundKey: vi.fn(), realAccount: vi.fn(),
}));
vi.mock("../src/lib/keys/chain.ts", () => ({ loadFollow: m.loadFollow, rpcView: () => async () => null, TESTNET_RPCS: ["https://a.example", "https://b.example"] }));
vi.mock("../src/lib/keys/wallet.ts", () => ({
  realAccount: (...a: unknown[]) => { m.realAccount(...a); return {}; },
  testnetWallet: () => ({ accountId: "a.testnet", buyViewingKey: m.buyViewingKey, refundKey: m.refundKey }),
}));

import { FollowLive, ONLY_TESTNET, isTestnetId } from "../src/components/FollowLive.tsx";

let host: HTMLDivElement, root: Root;
beforeEach(() => { vi.clearAllMocks(); m.loadFollow.mockResolvedValue({ params: PARAMS, sale: null, rulesHash: toHex(hashRules(RULES)), ciphertext: new Uint8Array(41) }); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

const render = async () => { await act(async () => { root.render(<FollowLive strategy={STRAT} />); }); };
const type = async (el: Element, value: string) => { await act(async () => { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!; setter.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); }); };
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); };
const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(label)) as HTMLButtonElement | undefined;
const inputs = () => [...host.querySelectorAll("input")] as HTMLInputElement[];
const accountInput = () => inputs().find((i) => i.type === "text")!;
const secretInput = () => inputs().find((i) => i.type === "password")!;
const checkbox = () => inputs().find((i) => i.type === "checkbox")!;

async function toBuyStep() {
  await render();
  await type(accountInput(), "alice.testnet");
  await click(button("Load from testnet")!);
  await click(button("Step 1")!);
}

describe("N2: the .testnet gate", () => {
  it.each([["alice.near", true], ["alice.testnet", false], ["testnet", true], ["ALICE.testnet", true], ["a b.testnet", true]])("account %j refused=%s", async (acct, refused) => {
    expect(isTestnetId(acct as string)).toBe(!refused);
    await render();
    await type(accountInput(), acct as string);
    await click(button("Load from testnet")!);
    if (refused) { expect(host.textContent).toContain(ONLY_TESTNET); expect(m.loadFollow).not.toHaveBeenCalled(); }
    else expect(m.loadFollow).toHaveBeenCalledTimes(1);
  });
});

describe("EC-K08w: save the pair before paying", () => {
  it("the buy button is disabled until the pair is shown, the box is ticked and a key is typed", async () => {
    await toBuyStep();
    expect(button("Buy viewing key")!.disabled).toBe(true);
    await type(secretInput(), TESTNET_SECRET);
    expect(button("Buy viewing key")!.disabled).toBe(true); // not saved yet
    await click(checkbox());
    expect(button("Buy viewing key")!.disabled).toBe(false);
    expect(m.buyViewingKey).not.toHaveBeenCalled();
  });
});

describe("H5: the testnet secret is cleared and never printed", () => {
  it("after a successful buy the secret field is empty and the secret is nowhere in the page", async () => {
    const log = vi.spyOn(console, "log"), err = vi.spyOn(console, "error");
    m.buyViewingKey.mockResolvedValue(undefined);
    await toBuyStep();
    await click(checkbox());
    await type(secretInput(), TESTNET_SECRET);
    await click(button("Buy viewing key")!);
    expect(m.buyViewingKey).toHaveBeenCalledTimes(1);
    expect(m.realAccount).toHaveBeenCalledWith("alice.testnet", TESTNET_SECRET);
    expect(secretInput().value).toBe("");
    expect(host.innerHTML).not.toContain(TESTNET_SECRET);
    for (const c of [...log.mock.calls, ...err.mock.calls]) expect(JSON.stringify(c)).not.toContain(TESTNET_SECRET);
  });
  it("after a refused buy the secret field is still cleared, the contract's text is shown, and the views are re-read", async () => {
    m.buyViewingKey.mockRejectedValue(new Error("LIMIT: key price"));
    await toBuyStep();
    await click(checkbox());
    await type(secretInput(), TESTNET_SECRET);
    const loadsBefore = m.loadFollow.mock.calls.length;
    await click(button("Buy viewing key")!);
    expect(secretInput().value).toBe("");
    expect(host.textContent).toContain("LIMIT: key price");
    expect(host.innerHTML).not.toContain(TESTNET_SECRET);
    expect(m.loadFollow.mock.calls.length).toBeGreaterThan(loadsBefore);
  });
  it("after a refund the secret field is cleared too", async () => {
    const esc = parseKeySale({ buyer: "alice.testnet", buyer_pubkey: "ab".repeat(32), state: "Escrowed", bought_at_ns: "1", price: "1000", sealed_key: null });
    m.loadFollow.mockResolvedValue({ params: PARAMS, sale: esc, rulesHash: "ab".repeat(32), ciphertext: new Uint8Array(41) });
    m.refundKey.mockResolvedValue(undefined);
    await render();
    await type(accountInput(), "alice.testnet");
    await click(button("Load from testnet")!);
    await type(secretInput(), TESTNET_SECRET);
    await click(button("Ask for a refund")!);
    expect(m.refundKey).toHaveBeenCalledTimes(1);
    expect(secretInput().value).toBe("");
    expect(host.innerHTML).not.toContain(TESTNET_SECRET);
  });
});

describe("N1: the sale view is asked for the typed account", () => {
  it("loadFollow is called with the strategy and the trimmed account", async () => {
    await render();
    await type(accountInput(), "  alice.testnet ");
    await click(button("Load from testnet")!);
    expect(m.loadFollow.mock.calls[0]!.slice(2)).toEqual([STRAT, "alice.testnet"]);
  });
});

describe("A1: a failed reload after a buy leaves no stale buy button", () => {
  it("data is cleared, so a second pay click is impossible", async () => {
    m.buyViewingKey.mockResolvedValue(undefined);
    await toBuyStep();
    await click(checkbox());
    await type(secretInput(), TESTNET_SECRET);
    m.loadFollow.mockRejectedValue(new Error("rpc down"));
    await click(button("Buy viewing key")!);
    expect(m.buyViewingKey).toHaveBeenCalledTimes(1);
    expect(button("Buy viewing key")).toBeUndefined();
    expect(button("Step 1")).toBeUndefined();
  });
});

describe("A2: key shape, no echo, pair dropped after unlock", () => {
  it.each(["", "hunter2", "ed25519:short", "ed25519:" + "0".repeat(87), "secp256k1:" + "z".repeat(87)])("a pasted key %j is refused before anything is sent, and never echoed", async (bad) => {
    await toBuyStep();
    await click(checkbox());
    await type(secretInput(), bad);
    const b = button("Buy viewing key")!;
    if (bad.trim() === "") { expect(b.disabled).toBe(true); return; }
    await click(b);
    expect(m.buyViewingKey).not.toHaveBeenCalled();
    expect(m.realAccount).not.toHaveBeenCalled();
    expect(host.textContent).toContain("does not look like a testnet secret key");
    expect(host.textContent).not.toContain(bad);
  });
  it("a wallet error that contains the key is shown with the key hidden", async () => {
    m.buyViewingKey.mockRejectedValue(new Error(`bad signature for ${TESTNET_SECRET}`));
    await toBuyStep();
    await click(checkbox());
    await type(secretInput(), TESTNET_SECRET);
    await click(button("Buy viewing key")!);
    expect(host.textContent).toContain("bad signature for [hidden]");
    expect(host.innerHTML).not.toContain(TESTNET_SECRET);
  });
});

// ---- A2: unlock, Released sale, post-buy view change, malformed key ----
import { encryptRules } from "@poolside/rules";
import { sealedBox } from "../src/lib/keys/deps.ts";
import { exportSecret } from "../src/lib/keys/flow.ts";

const releasedFor = async (kp: { publicKey: Uint8Array; secretKey: Uint8Array }, strategy = STRAT) => {
  const K = crypto.getRandomValues(new Uint8Array(32));
  const ct = encryptRules(RULES, K, crypto.getRandomValues(new Uint8Array(24)), strategy);
  const sale = parseKeySale({ buyer: "alice.testnet", buyer_pubkey: toHex(kp.publicKey), state: "Released", bought_at_ns: "1", price: "1000", sealed_key: toHex(await sealedBox.seal(kp.publicKey, K)) });
  return { params: PARAMS, sale, rulesHash: toHex(hashRules(RULES)), ciphertext: ct };
};
const loadReleased = async (data: unknown) => { m.loadFollow.mockResolvedValue(data); await render(); await type(accountInput(), "alice.testnet"); await click(button("Load from testnet")!); };
const backupBox = () => host.querySelector("textarea") as HTMLTextAreaElement;
const typeArea = async (el: HTMLTextAreaElement, value: string) => { await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); }); };

describe("A2.1: the unlock handler", () => {
  it("a Released sale with the valid backup shows the rules and the hash line", async () => {
    const kp = await sealedBox.generateKeyPair();
    await loadReleased(await releasedFor(kp));
    await typeArea(backupBox(), exportSecret(kp));
    await click(button("Unlock rules")!);
    expect(host.textContent).toContain("Hash check: the rules you decrypted match the rules hash committed on the testnet contract");
    expect(host.querySelector("pre")!.textContent).toContain('"stop_loss_bps": 1000');
    expect(backupBox()?.value ?? "").toBe(""); // the backup text is dropped once the rules are shown
  });
  it("a backup whose public key does not belong to the secret shows nothing", async () => {
    const kp = await sealedBox.generateKeyPair(), other = await sealedBox.generateKeyPair();
    await loadReleased(await releasedFor(kp));
    await typeArea(backupBox(), exportSecret({ publicKey: kp.publicKey, secretKey: other.secretKey }));
    await click(button("Unlock rules")!);
    expect(host.textContent).toContain("do not belong together. Nothing was shown.");
    expect(host.querySelector("pre")).toBeNull();
  });
  it("a junk backup shows the backup-format error and no rules", async () => {
    const kp = await sealedBox.generateKeyPair();
    await loadReleased(await releasedFor(kp));
    await typeArea(backupBox(), "hello");
    await click(button("Unlock rules")!);
    expect(host.textContent).toContain("This is not a hoodx LP agent viewing key backup.");
    expect(host.querySelector("pre")).toBeNull();
  });
  it("Unlock is disabled with no backup and no pair", async () => {
    const kp = await sealedBox.generateKeyPair();
    await loadReleased(await releasedFor(kp));
    expect(button("Unlock rules")!.disabled).toBe(true);
  });
  it("a sale sealed to another buyer's key shows the failed-check text, not the rules", async () => {
    const kp = await sealedBox.generateKeyPair(), other = await sealedBox.generateKeyPair();
    const d = await releasedFor(other);
    await loadReleased({ ...d, sale: parseKeySale({ ...d.sale!, buyer_pubkey: toHex(kp.publicKey), bought_at_ns: "1", price: "1000", buyer: "alice.testnet", sealed_key: d.sale!.sealedKey, state: "Released" }) });
    await typeArea(backupBox(), exportSecret(kp));
    await click(button("Unlock rules")!);
    expect(host.textContent).toContain("Nothing was shown");
    expect(host.querySelector("pre")).toBeNull();
  });
});

describe("A2.2 (web side of EC-K05): after delivery there is no refund", () => {
  it("a Released sale long past the window shows the delivered text and never a refund button", async () => {
    const kp = await sealedBox.generateKeyPair();
    await loadReleased(await releasedFor(kp));
    expect(host.textContent).toContain("Your key has arrived. Unlock it in this browser with your saved secret key.");
    expect(button("Ask for a refund")).toBeUndefined();
    expect(host.textContent).not.toContain("the delivery window has passed");
  });
});

describe("A2.3: the pasted key is cleared on every path", () => {
  it("a malformed key clears the field", async () => {
    await toBuyStep();
    await click(checkbox());
    await type(secretInput(), "not-a-key");
    await click(button("Buy viewing key")!);
    expect(secretInput().value).toBe("");
    expect(m.realAccount).not.toHaveBeenCalled();
  });
  it("a wallet set-up that throws clears the field too", async () => {
    m.realAccount.mockImplementationOnce(() => { throw new Error("setup failed"); });
    await toBuyStep();
    await click(checkbox());
    await type(secretInput(), TESTNET_SECRET);
    await click(button("Buy viewing key")!);
    expect(host.textContent).toContain("setup failed");
    expect(secretInput().value).toBe("");
  });
});

describe("A2.4: after a successful buy the view changes and the key input is gone", () => {
  it("the password field unmounts when the sale appears, and the page shows the waiting text", async () => {
    const log = vi.spyOn(console, "log");
    const esc = parseKeySale({ buyer: "alice.testnet", buyer_pubkey: "ab".repeat(32), state: "Escrowed", bought_at_ns: String(BigInt(Date.now()) * 1_000_000n), price: "1000", sealed_key: null });
    m.buyViewingKey.mockImplementation(async () => { m.loadFollow.mockResolvedValue({ params: { ...PARAMS, sold: 1 }, sale: esc, rulesHash: "ab".repeat(32), ciphertext: new Uint8Array(41) }); });
    await toBuyStep();
    await click(checkbox());
    await type(secretInput(), TESTNET_SECRET);
    await click(button("Buy viewing key")!);
    expect(host.querySelector('input[type="password"]')).toBeNull();
    expect(host.textContent).toContain("Design of the key sale");
    expect(host.innerHTML).not.toContain(TESTNET_SECRET);
    for (const c of log.mock.calls) expect(JSON.stringify(c)).not.toContain(TESTNET_SECRET);
  });
});
