// Manual registration writes the same 记录.json row harvest does. The HTTP
// route is covered in test/e2e/server.e2e.test.mjs; this file owns validation
// and the persistence shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendEntry, parseSessionRef, readEntries, registerManualSession } from "../src/archive.mjs";

const SID = "44444444-4444-4444-8444-444444444444";
const OTHER = "55555555-5555-4555-8555-555555555555";

function tmpArchive() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "arena-manual-"));
}

test("parseSessionRef accepts a UUID and lower-cases it", () => {
  const parsed = parseSessionRef(`  ${SID.toUpperCase()}  `);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.sessionId, SID);
});

test("parseSessionRef accepts an Arena agent URL, including query, hash and www", () => {
  const parsed = parseSessionRef(`<https://www.arena.ai/agent/${SID.toUpperCase()}?ref=1#top>`);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.sessionId, SID);
});

test("parseSessionRef accepts a quoted UUID and a bare /agent path", () => {
  assert.equal(parseSessionRef(`"${SID}"`).sessionId, SID);
  assert.equal(parseSessionRef(`/agent/${SID}/`).sessionId, SID);
});

test("parseSessionRef rejects an empty value and a non-uuid", () => {
  assert.equal(parseSessionRef("   ").code, "invalid_session");
  assert.equal(parseSessionRef("not-a-session").code, "invalid_session");
  assert.equal(parseSessionRef("a".repeat(2049)).code, "invalid_session");
});

test("parseSessionRef reports a link that has no agent id as not found", () => {
  const parsed = parseSessionRef("https://arena.ai/c/hello");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "not_found");
  assert.match(parsed.error, /agent/);
});

test("registerManualSession appends the same record shape harvest writes", (t) => {
  const dir = tmpArchive();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const harvested = appendEntry(dir, {
    sessionId: OTHER,
    model: "kimi-k3",
    url: `https://arena.ai/agent/${OTHER}`,
    email: "harvest@example.com",
    prompt: "1+1=",
  });

  const added = registerManualSession(dir, {
    session: `https://arena.ai/agent/${SID}?x=1`,
    model: "gpt-5",
    note: "从浏览器复制",
    email: "owner@example.com",
  });
  assert.equal(added.ok, true);
  assert.equal(added.sessionId, SID);
  assert.deepEqual(Object.keys(added.record).sort(), Object.keys(harvested).sort());
  assert.equal(added.record.Source, "arena-bridge");
  assert.equal(added.record.Profile, "arena-bridge");
  assert.equal(added.record.Model, "gpt-5");
  assert.equal(added.record.Prompt, "从浏览器复制");
  assert.equal(added.record.Email, "owner@example.com");
  assert.equal(added.record.Url, `https://arena.ai/agent/${SID}`);
  assert.equal(added.record.Id, SID.replace(/-/g, ""));

  const stored = readEntries(dir);
  assert.equal(stored.length, 2);
  assert.match(fs.readFileSync(path.join(dir, "gpt-5", "清单.md"), "utf8"), new RegExp(SID));
  assert.match(fs.readFileSync(path.join(dir, "汇总.md"), "utf8"), /gpt-5/);
});

test("a blank model is archived as 未识别, the same sentinel harvest uses", (t) => {
  const dir = tmpArchive();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const added = registerManualSession(dir, { session: SID, model: "  ", note: "" });
  assert.equal(added.ok, true);
  assert.equal(added.record.Model, "未识别");
  assert.equal(added.record.Prompt, "");
  assert.equal(readEntries(dir)[0].Model, "未识别");
});

test("an id already in the archive is rejected and the file is left untouched", (t) => {
  const dir = tmpArchive();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  registerManualSession(dir, { session: SID, model: "gpt-5", note: "first" });
  const before = fs.readFileSync(path.join(dir, "记录.json"));

  const again = registerManualSession(dir, { session: SID.toUpperCase(), model: "other" });
  assert.equal(again.ok, false);
  assert.equal(again.status, 409);
  assert.equal(again.code, "already_present");
  assert.match(again.error, new RegExp(SID));

  const viaUrl = registerManualSession(dir, { session: `https://arena.ai/agent/${SID}` });
  assert.equal(viaUrl.code, "already_present");
  assert.deepEqual(fs.readFileSync(path.join(dir, "记录.json")), before);
});

test("registerManualSession refuses an unconfigured archive directory", () => {
  const result = registerManualSession("", { session: SID });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.code, "archive_unconfigured");
});

test("invalid input and over-long labels do not create an archive", (t) => {
  const dir = tmpArchive();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const invalid = registerManualSession(dir, { session: "nope" });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.code, "invalid_session");

  const missing = registerManualSession(dir, { session: "https://arena.ai/settings" });
  assert.equal(missing.status, 404);
  assert.equal(missing.code, "not_found");

  const model = registerManualSession(dir, { session: SID, model: "m".repeat(121) });
  assert.equal(model.code, "invalid_model");

  const note = registerManualSession(dir, { session: SID, note: "line\nbreak" });
  assert.equal(note.code, "invalid_note");

  assert.equal(fs.existsSync(path.join(dir, "记录.json")), false);
});

test("a corrupt archive is left unchanged", (t) => {
  const dir = tmpArchive();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "记录.json");
  const bytes = Buffer.from("{ not json");
  fs.writeFileSync(file, bytes);

  assert.throws(() => registerManualSession(dir, { session: SID, model: "gpt-5" }));
  assert.deepEqual(fs.readFileSync(file), bytes);
});
