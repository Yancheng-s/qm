import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { importAssembleFiles } from "../src/file-import.ts";
import type { CoreCall } from "../src/core-client.ts";

test("importAssembleFiles downloads, stages, and uploads files into the requested scope", async () => {
  const bytes = new TextEncoder().encode("hello docs");
  let staged: Uint8Array | undefined;
  let uploaded: unknown;
  const core = Object.assign(
    async (method: string, path: string, body?: unknown) => {
      assert.equal(method, "POST");
      assert.equal(path, "/v1/files/upload");
      uploaded = body;
      return {
        ok: true,
        status: 200,
        json: { file: { id: "file-1", name: "profile.md", mimetype: "text/markdown", sizeBytes: bytes.length } },
      } as const;
    },
    {
      async stageBlob(data: Uint8Array) {
        staged = data;
        return { ok: true, status: 200, json: { blobId: "blob-1" } } as const;
      },
    },
  ) as CoreCall;
  const fetchImpl = async () =>
    new Response(bytes, {
      status: 200,
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "content-length": String(bytes.length),
      },
    });

  const outcomes = await importAssembleFiles({
    core,
    principalId: "acme_u1",
    scopeId: "group:web-project-1",
    files: [
      {
        url: "https://93.184.216.34/profile.md",
        name: "profile.md",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: bytes.length,
      },
    ],
    fetchImpl,
  });

  assert.deepEqual(staged, bytes);
  assert.deepEqual(uploaded, {
    principalId: "acme_u1",
    scopeId: "group:web-project-1",
    blobId: "blob-1",
    name: "profile.md",
    mimetype: "text/markdown",
  });
  assert.deepEqual(outcomes, [
    { ok: true, file: { id: "file-1", name: "profile.md", mimetype: "text/markdown", sizeBytes: bytes.length } },
  ]);
});

test("importAssembleFiles rejects local file URLs before download", async () => {
  let fetched = false;
  const core = Object.assign(async () => ({ ok: true, status: 200, json: null }) as const, {
    async stageBlob() {
      throw new Error("unexpected stage");
    },
  }) as CoreCall;

  const outcomes = await importAssembleFiles({
    core,
    principalId: "acme_u1",
    scopeId: "group:web-project-1",
    files: [{ url: "https://127.0.0.1/profile.md" }],
    fetchImpl: async () => {
      fetched = true;
      return new Response("nope");
    },
  });

  assert.equal(fetched, false);
  assert.deepEqual(outcomes, [
    { ok: false, url: "https://127.0.0.1/profile.md", error: "file url host is not public" },
  ]);
});
