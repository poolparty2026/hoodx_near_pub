import { mkdtempSync, readFileSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkDirs, isHttps, isLocalHttp, makePrivateDir, parseInterval, redact } from "../src/safety.ts";
import { writeRecordFile } from "../src/records.ts";
import { decisionHash } from "@poolside/rules";
import type { LogEntry } from "../src/loop.ts";

const entry = (over: Partial<LogEntry>): LogEntry => ({ block: 7, decision: { kind: "hold" }, decisionHash: "ab".repeat(32), record: "", sent: null, error: null, ...over });

describe("log redaction (T78, audit HIGH-1)", () => {
  const SECRET = '{"v":1,"state":{"stop_loss_bps":1234}}';
  it("never carries the record text", () => {
    const line = JSON.stringify(redact(entry({ record: SECRET })));
    expect(line).not.toContain("stop_loss_bps");
    expect(line).not.toContain("record");
    expect(line).toContain("ab".repeat(32));
  });
  it("withholds an error message that contains the record", () => {
    const line = JSON.stringify(redact(entry({ record: SECRET, error: `bad: ${SECRET}` })));
    expect(line).not.toContain("stop_loss_bps");
  });
  it("T78 (audit M2): never carries the decision kind, so a hold line says nothing about the hidden bounds", () => {
    for (const decision of [{ kind: "hold" as const }, { kind: "open" as const, left: -8500, right: -7500 }]) {
      const line = JSON.stringify(redact(entry({ decision })));
      expect(line).not.toContain("decision\"");
      expect(line).not.toContain("hold");
      expect(line).not.toContain("open");
    }
  });
  it("keeps an ordinary error", () => {
    expect(redact(entry({ error: "rpc timeout" })).error).toBe("rpc timeout");
  });
});

describe("start checks", () => {
  it("INTERVAL_S must be a whole number of seconds from 1 to 86400", () => {
    for (const ok of ["1", "60", "86400"]) expect(parseInterval(ok)).toBe(Number(ok));
    for (const bad of ["", "0", "-1", "abc", "NaN", "1.5", "86401", "1e3", " 5", "00001"]) expect(() => parseInterval(bad)).toThrow();
  });
  it("the localhost guard compares the parsed hostname", () => {
    expect(isLocalHttp("http://127.0.0.1:3030")).toBe(true);
    expect(isLocalHttp("http://localhost:3030/")).toBe(true);
    for (const bad of ["http://127.0.0.1:1@evil.example/", "http://127.0.0.1.evil.example:80", "http://localhost.evil.example/", "https://127.0.0.1:3030", "http://evil.example/", "not a url"]) expect(isLocalHttp(bad)).toBe(false);
  });
  it("https only, no userinfo", () => {
    expect(isHttps("https://rpc.mainnet.near.org")).toBe(true);
    for (const bad of ["http://rpc.mainnet.near.org", "https://u:p@rpc.example/", "ftp://x", "x"]) expect(isHttps(bad)).toBe(false);
  });
  it("refuses equal or nested held and published directories", () => {
    expect(() => checkDirs("/a/x", "/a/x")).toThrow();
    expect(() => checkDirs("/a/x", "/a/x/pub")).toThrow();
    expect(() => checkDirs("/a/x/held", "/a/x")).toThrow();
    expect(() => checkDirs("/a/x/../x", "/a/x")).toThrow();
    expect(() => checkDirs("/a/held", "/a/pub")).not.toThrow();
    expect(() => checkDirs("/a/held", "/a/held2")).not.toThrow();
  });
  it("the held store is 0700 and its files 0600", () => {
    const base = mkdtempSync(join(tmpdir(), "safety-"));
    const dir = join(base, "held");
    makePrivateDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const text = "x";
    writeRecordFile(dir, decisionHash(text), text, 0o600);
    const f = readdirSync(dir)[0] as string;
    expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, f), "utf8")).toBe(text);
  });
});
