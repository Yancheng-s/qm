import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sha256Hex } from "../src/sha256.ts";
import { uploadAttachments } from "../src/core-bridge.ts";

const bytes = Uint8Array.from({ length: 129 }, (_, index) => index);
const expected = createHash("sha256").update(bytes).digest("hex");

test("SHA-256 matches Node for binary data in a secure context", async () => {
  assert.equal(await sha256Hex(bytes), expected);
});

test("HTTP contexts can hash and upload attachments without crypto.subtle", async () => {
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: Uint8Array }> = [];
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: {} });
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), body: init?.body as Uint8Array });
    return new Response(JSON.stringify({ blobId: "blob-1", sizeBytes: bytes.length }), { status: 200 });
  }) as typeof fetch;
  try {
    assert.equal(await sha256Hex(bytes), expected);
    const largeBytes = new Uint8Array(1_048_577).fill(247);
    assert.equal(await sha256Hex(largeBytes), createHash("sha256").update(largeBytes).digest("hex"));
    const result = await uploadAttachments([
      {
        id: "attachment-1",
        type: "image",
        fileName: "image.jpg",
        mimeType: "image/jpeg",
        size: bytes.length,
        content: Buffer.from(bytes).toString("base64"),
      },
    ]);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(result.uploaded, [
      { name: "image.jpg", mimetype: "image/jpeg", sizeBytes: bytes.length, blobId: "blob-1" },
    ]);
    assert.equal(requests.length, 1);
    assert.match(requests[0]!.url, new RegExp(`\\?sha=${expected}$`));
    assert.deepEqual(requests[0]!.body, bytes);
  } finally {
    if (originalCrypto) Object.defineProperty(globalThis, "crypto", originalCrypto);
    else Reflect.deleteProperty(globalThis, "crypto");
    globalThis.fetch = originalFetch;
  }
});
