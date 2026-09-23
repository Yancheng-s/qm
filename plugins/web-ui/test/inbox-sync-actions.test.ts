import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/inbox.ts", import.meta.url), "utf8");

test("inbox sync states use the same labeled action button", () => {
  assert.match(source, /function syncActionTpl/);
  assert.match(source, /class="btn inbox-sync-action"/);
  assert.match(source, /label: "刷新"/);
  assert.match(source, /label: "同步"/);
  assert.match(source, /class="inbox-setup-action"/);
  assert.match(source, /busyLabel: "正在刷新…"/);
  assert.match(source, /busyLabel: "正在同步…"/);
  assert.match(source, /"正在设置…" : "设置"/);
});
