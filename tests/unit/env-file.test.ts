// The .env loader must survive what Windows editors and shells actually write, and explain mistakes.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { decodeEnvBuffer, envFileStatus, loadConfig, parseEnvText } from "../../server/config";

const KEY = "0123456789abcdef0123456789abcdef";

describe(".env parsing", () => {
  it("reads UTF-8 with a byte-order mark (Notepad) and UTF-16 (PowerShell 5 redirection)", () => {
    const line = `ODDS_API_KEY=${KEY}\r\n`;
    expect(parseEnvText(decodeEnvBuffer(Buffer.from("﻿" + line, "utf8")))).toEqual({ ODDS_API_KEY: KEY });
    expect(parseEnvText(decodeEnvBuffer(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(line, "utf16le")])))).toEqual({ ODDS_API_KEY: KEY });
    expect(parseEnvText(decodeEnvBuffer(Buffer.from(line, "utf16le")))).toEqual({ ODDS_API_KEY: KEY });
    const be = Buffer.from(line, "utf16le");
    be.swap16();
    expect(parseEnvText(decodeEnvBuffer(Buffer.concat([Buffer.from([0xfe, 0xff]), be])))).toEqual({ ODDS_API_KEY: KEY });
  });

  it("accepts spaces, quotes, export and comments", () => {
    const text = [`# comment`, `ODDS_API_KEY = "${KEY}"`, `export PORT=5181`, `INSTRUCTOR_PIN='12 34'`, `AI_MODEL=claude # trailing comment`, `EMPTY=`, `not a setting`].join("\n");
    expect(parseEnvText(text)).toEqual({ ODDS_API_KEY: KEY, PORT: "5181", INSTRUCTOR_PIN: "12 34", AI_MODEL: "claude", EMPTY: "" });
  });
});

describe(".env diagnostics", () => {
  const cwd = process.cwd();
  const saved = { ...process.env };
  let dir = "";
  const run = (files: Record<string, string>) => {
    dir = mkdtempSync(path.join(tmpdir(), "envtest-"));
    for (const [name, content] of Object.entries(files)) {
      const p = path.join(dir, name);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
    for (const k of ["ODDS_API_KEY", "BALLDONTLIE_API_KEY", "ANTHROPIC_API_KEY", "ODDSAPI_KEY"]) delete process.env[k];
    process.chdir(dir);
    const cfg = loadConfig();
    return { cfg, status: envFileStatus()! };
  };
  afterEach(() => {
    process.chdir(cwd);
    process.env = { ...saved };
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("loads the key and reports setting names only", () => {
    const { cfg, status } = run({ ".env": `﻿ODDS_API_KEY=${KEY}\n` });
    expect(cfg.oddsApiKey).toBe(KEY);
    expect(status.found).toBe(true);
    expect(status.keys).toEqual(["ODDS_API_KEY"]);
    expect(status.hints).toEqual([]);
    expect(JSON.stringify(status)).not.toContain(KEY);
  });

  it("explains a hidden .txt extension, a filled-in .env.example and a file in the wrong folder", () => {
    expect(run({ ".env.txt": `ODDS_API_KEY=${KEY}` }).status.hints[0]).toMatch(/"\.env\.txt" but not "\.env"/);
    process.chdir(cwd);
    expect(run({ ".env.example": `ODDS_API_KEY=${KEY}` }).status.hints[0]).toMatch(/inside "\.env\.example"/);
    process.chdir(cwd);
    expect(run({ "client/.env": `ODDS_API_KEY=${KEY}` }).status.hints[0]).toMatch(/must be in the project folder/);
  });

  it("flags misnamed settings, empty values and placeholders without echoing values", () => {
    const { cfg, status } = run({ ".env": `ODDSAPI_KEY=${KEY}\nBALLDONTLIE_API_KEY=\nANTHROPIC_API_KEY=paste your key here\n` });
    expect(cfg.oddsApiKey).toBeNull();
    expect(status.hints.join(" ")).toMatch(/ODDSAPI_KEY.*Did you mean ODDS_API_KEY/);
    expect(status.hints.join(" ")).toMatch(/BALLDONTLIE_API_KEY is in "\.env" but has no value/);
    expect(status.hints.join(" ")).toMatch(/ANTHROPIC_API_KEY .* placeholder/);
    expect(JSON.stringify(status)).not.toContain(KEY);
  });
});
