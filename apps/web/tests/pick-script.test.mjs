/**
 * The native picker has two callers with different safety requirements: Studio expects audio files,
 * while Library needs the selected folder itself. These tests pin the AppleScript branch so a future
 * edit cannot silently return file paths to the scanner or enable multi-selection for a folder.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPickScript } from "../../../tools/pick-script.mjs";

test("folder mode asks for a folder and returns its POSIX path", () => {
  const built = buildPickScript({ kind: "folder" });
  assert.equal(built.folderMode, true);
  assert.equal(built.multiple, false);
  assert.match(built.script, /choose folder with prompt "选择音乐文件夹"/);
  assert.match(built.script, /POSIX path of theFolder/);
  assert.doesNotMatch(built.script, /public\.audio/);
  assert.doesNotMatch(built.script, /multiple selections/);
});

test("file mode keeps the Studio audio allowlist and supports opt-in multi-selection", () => {
  const one = buildPickScript({ kind: "file" });
  assert.equal(one.folderMode, false);
  assert.equal(one.multiple, false);
  assert.match(one.script, /public\.audio/);
  assert.doesNotMatch(one.script, /multiple selections/);

  const many = buildPickScript({ kind: "file", multiple: true });
  assert.equal(many.multiple, true);
  assert.match(many.script, /multiple selections allowed/);
});

test("unknown request shapes fall back to a single audio file", () => {
  const built = buildPickScript(undefined);
  assert.equal(built.folderMode, false);
  assert.equal(built.multiple, false);
  assert.match(built.script, /choose file with prompt "选择音频文件"/);
});
