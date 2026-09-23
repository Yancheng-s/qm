import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUuid } from "../src/random-uuid.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("randomUuid uses crypto.randomUUID when present", () => {
  const id = randomUuid();
  assert.match(id, UUID_RE);
  assert.notEqual(randomUuid(), id);
});

test("randomUuid falls back when randomUUID is missing", () => {
  const cryptoObj = globalThis.crypto as Crypto & { randomUUID?: () => string };
  const original = cryptoObj.randomUUID;
  cryptoObj.randomUUID = undefined;
  try {
    const id = randomUuid();
    assert.match(id, UUID_RE);
    assert.notEqual(randomUuid(), id);
  } finally {
    cryptoObj.randomUUID = original;
  }
});
