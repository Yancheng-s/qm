import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");

test("transcript edges do not blur or mask the response", () => {
  assert.doesNotMatch(css, /\.chat-scroll::(?:before|after)/);
  assert.doesNotMatch(css, /\.message-stack \.user-row[^{}]* > \.user-bubble::(?:before|after)/);
  assert.doesNotMatch(css, /--chat-edge-fade/);
});

test("the composer has an elevated solid surface and user prompts do not", () => {
  const composer = css.match(/^\.composer-wrap \{[^}]*\}/m)?.[0] ?? "";
  assert.doesNotMatch(css, /\.user-row\.stuck/);
  assert.match(composer, /background: var\(--background\);/);
  assert.match(composer, /box-shadow:\s*0 2px 5px rgb\(0 0 0 \/ 0\.05\),\s*0 8px 24px rgb\(0 0 0 \/ 0\.06\);/);
});

test("user prompts do not take the shared surface shadow", () => {
  const root = css.match(/:root \{[^}]*\}/)?.[0] ?? "";
  const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
  assert.match(root, /--chat-surface-shadow:/);
  assert.doesNotMatch(css, /\.user-row[^{]*\{[^}]*--chat-surface-shadow/);
  assert.doesNotMatch(chat, /markStuckUserRow/);
});
