import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decisionHash } from "@poolside/rules";
import { writeFileSync } from "node:fs";
import { listRecordFiles, readRecordFile, writeRecordFile } from "../src/index.ts";

const text = '{"decision":{"kind":"hold"},"version":1}';
const hash = decisionHash(text);

describe("record files (INTERFACE section 5: flat, content-addressed)", () => {
  it("writes exactly the text under its hash, with no trailing newline, and reads it back", () => {
    const dir = mkdtempSync(join(tmpdir(), "records-"));
    writeRecordFile(dir, hash, text);
    expect(readdirSync(dir)).toEqual([`${hash}.txt`]);
    expect(readFileSync(join(dir, `${hash}.txt`))).toEqual(Buffer.from(text, "utf8"));
    expect(readRecordFile(dir, hash)).toBe(text);
    expect(readRecordFile(dir, "ab".repeat(32))).toBeNull();
    expect(readRecordFile(dir, "../x")).toBeNull();
  });
  it("is immutable: the same text again is a no-op; a name that isn't the text's hash or a bad name is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "records-"));
    writeRecordFile(dir, hash, text);
    writeRecordFile(dir, hash, text);
    expect(() => writeRecordFile(dir, hash, text + " ")).toThrow(/does not hash/);
    expect(() => writeRecordFile(dir, "ab".repeat(32), text)).toThrow(/does not hash/);
    expect(() => writeRecordFile(dir, "../etc/passwd", text)).toThrow(/64 lowercase hex/);
    expect(() => writeRecordFile(dir, hash.toUpperCase(), text)).toThrow(/64 lowercase hex/);
    expect(readdirSync(dir)).toEqual([`${hash}.txt`]);
  });
  it("a read returns the text only if it hashes to the file's name; a corrupt or swapped file is invisible", () => {
    const dir = mkdtempSync(join(tmpdir(), "records-"));
    writeRecordFile(dir, hash, text);
    writeFileSync(join(dir, `${hash}.txt`), text + "x");
    expect(readRecordFile(dir, hash)).toBeNull();
    expect(listRecordFiles(dir)).toEqual([]);
    // A leftover temp file from an interrupted write is not listed either.
    writeFileSync(join(dir, `.${hash}.123.tmp`), text);
    expect(listRecordFiles(dir)).toEqual([]);
  });
});
