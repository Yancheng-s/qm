import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { asObject, numberField, stringField, upstreamProblem, type CoreCall } from "./core-client.ts";
import { problem, type Problem } from "./transport.ts";

export const MAX_ASSEMBLE_FILES = 20;
export const MAX_ASSEMBLE_FILE_BYTES = 100 * 1024 * 1024;
export const FILE_DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const SHA256 = /^[0-9a-f]{64}$/;

export interface AssembleFile {
  url: string;
  name?: string;
  mimetype?: string;
  sha256?: string;
  sizeBytes?: number;
}

export interface ImportedFile {
  id: string;
  name: string;
  mimetype: string;
  sizeBytes: number;
}

export type FileImportOutcome =
  { ok: true; file: ImportedFile } | { ok: false; url: string; name?: string; error: string };

export type FileImportParse = { ok: true; files: AssembleFile[] } | { ok: false; problem: Problem };

export function parseAssembleFiles(value: unknown): FileImportParse {
  if (value === undefined || value === null) return { ok: true, files: [] };
  if (!Array.isArray(value)) return { ok: false, problem: problem(400, "bad_request", "files must be an array") };
  if (value.length > MAX_ASSEMBLE_FILES)
    return {
      ok: false,
      problem: problem(400, "bad_request", `files accepts at most ${MAX_ASSEMBLE_FILES} entries`),
    };
  const files: AssembleFile[] = [];
  for (const entry of value) {
    const item = asObject(entry);
    if (!item) return { ok: false, problem: problem(400, "bad_request", "each file must be an object") };
    const url = typeof item.url === "string" ? item.url.trim() : "";
    if (!url) return { ok: false, problem: problem(400, "bad_request", "each file requires url") };
    const parsed = parseHttpsUrl(url);
    if (!parsed.ok) return { ok: false, problem: parsed.problem };
    const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : undefined;
    const mimetype = typeof item.mimetype === "string" && item.mimetype.trim() ? item.mimetype.trim() : undefined;
    const sha256 = typeof item.sha256 === "string" && item.sha256.trim() ? item.sha256.trim().toLowerCase() : undefined;
    if (sha256 && !SHA256.test(sha256))
      return { ok: false, problem: problem(400, "bad_request", "file sha256 must be 64 lowercase hex characters") };
    const sizeBytes = item.sizeBytes === undefined ? undefined : item.sizeBytes;
    if (
      sizeBytes !== undefined &&
      (typeof sizeBytes !== "number" ||
        !Number.isInteger(sizeBytes) ||
        sizeBytes < 0 ||
        sizeBytes > MAX_ASSEMBLE_FILE_BYTES)
    )
      return {
        ok: false,
        problem: problem(400, "bad_request", `file sizeBytes must be an integer <= ${MAX_ASSEMBLE_FILE_BYTES}`),
      };
    files.push({
      url,
      ...(name ? { name } : {}),
      ...(mimetype ? { mimetype } : {}),
      ...(sha256 ? { sha256 } : {}),
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    });
  }
  return { ok: true, files };
}

export async function importAssembleFiles(input: {
  core: CoreCall;
  principalId: string;
  scopeId: string;
  files: readonly AssembleFile[];
  fetchImpl?: typeof fetch;
}): Promise<FileImportOutcome[]> {
  const out: FileImportOutcome[] = [];
  for (const file of input.files) out.push(await importOne({ ...input, file }));
  return out;
}

function parseHttpsUrl(raw: string): { ok: true; url: URL } | { ok: false; problem: Problem } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, problem: problem(400, "bad_request", "file url must be a valid URL") };
  }
  if (url.protocol !== "https:") return { ok: false, problem: problem(400, "bad_request", "file url must use https") };
  if (!url.hostname) return { ok: false, problem: problem(400, "bad_request", "file url must include a host") };
  return { ok: true, url };
}

async function importOne(input: {
  core: CoreCall;
  principalId: string;
  scopeId: string;
  file: AssembleFile;
  fetchImpl?: typeof fetch;
}): Promise<FileImportOutcome> {
  try {
    if (!input.core.stageBlob) throw new Error("core client cannot stage binary blobs");
    const downloaded = await downloadFile(input.file, input.fetchImpl ?? fetch);
    const staged = await input.core.stageBlob(downloaded.bytes);
    if (!staged.ok)
      return {
        ok: false,
        url: input.file.url,
        name: downloaded.name,
        error: String(staged.problem.body.message ?? "blob staging failed"),
      };
    if (staged.status !== 200)
      return { ok: false, url: input.file.url, name: downloaded.name, error: `core replied ${staged.status}` };
    const blobId = stringField(staged.json, "blobId");
    if (!blobId) return { ok: false, url: input.file.url, name: downloaded.name, error: "core returned no blobId" };
    const uploaded = await input.core("POST", "/v1/files/upload", {
      principalId: input.principalId,
      scopeId: input.scopeId,
      blobId,
      name: downloaded.name,
      mimetype: downloaded.mimetype,
    });
    if (!uploaded.ok)
      return {
        ok: false,
        url: input.file.url,
        name: downloaded.name,
        error: String(uploaded.problem.body.message ?? "file upload failed"),
      };
    if (uploaded.status !== 200) {
      const p = upstreamProblem(uploaded.status, uploaded.json, "file upload failed");
      return { ok: false, url: input.file.url, name: downloaded.name, error: String(p.body.message) };
    }
    const item = asObject(asObject(uploaded.json)?.file);
    const id = stringField(item, "id");
    const name = stringField(item, "name");
    const mimetype = stringField(item, "mimetype");
    const sizeBytes = numberField(item, "sizeBytes");
    if (!id || !name || !mimetype || sizeBytes === undefined)
      return { ok: false, url: input.file.url, name: downloaded.name, error: "core returned an unexpected file" };
    return { ok: true, file: { id, name, mimetype, sizeBytes } };
  } catch (e) {
    return {
      ok: false,
      url: input.file.url,
      ...(input.file.name ? { name: input.file.name } : {}),
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function downloadFile(
  file: AssembleFile,
  fetchImpl: typeof fetch,
): Promise<{ name: string; mimetype: string; bytes: Uint8Array }> {
  let current = new URL(file.url);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    await assertPublicHttps(current);
    const response = await fetchImpl(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(FILE_DOWNLOAD_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("file download redirect had no location");
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new Error(`file download replied ${response.status}`);
    const declared = response.headers.get("content-length");
    const declaredSize = declared ? Number(declared) : undefined;
    if (declaredSize !== undefined && (!Number.isFinite(declaredSize) || declaredSize > MAX_ASSEMBLE_FILE_BYTES))
      throw new Error(`file exceeds ${MAX_ASSEMBLE_FILE_BYTES} bytes`);
    if (file.sizeBytes !== undefined && declaredSize !== undefined && declaredSize !== file.sizeBytes)
      throw new Error("file sizeBytes does not match content-length");
    const bytes = await collectResponseBytes(response, MAX_ASSEMBLE_FILE_BYTES);
    if (file.sizeBytes !== undefined && bytes.length !== file.sizeBytes)
      throw new Error("file sizeBytes does not match downloaded bytes");
    if (file.sha256) {
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== file.sha256) throw new Error("file sha256 mismatch");
    }
    return {
      name: file.name ?? nameFromDisposition(response.headers.get("content-disposition")) ?? nameFromUrl(current),
      mimetype:
        (file.mimetype ?? response.headers.get("content-type") ?? "application/octet-stream")
          .split(";")[0]!
          .trim()
          .toLowerCase() || "application/octet-stream",
      bytes,
    };
  }
  throw new Error("file download redirected too many times");
}

async function collectResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`file exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function assertPublicHttps(url: URL): Promise<void> {
  if (url.protocol !== "https:") throw new Error("file url must use https");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) throw new Error("file url host is not public");
  const directIp = isIP(host);
  const addresses = directIp ? [{ address: host }] : await dnsLookup(host, { all: true, verbatim: true });
  if (!addresses.length) throw new Error("file url host did not resolve");
  for (const address of addresses)
    if (isPrivateAddress(address.address)) throw new Error("file url host is not public");
}

function isPrivateAddress(address: string): boolean {
  if (address.startsWith("::ffff:")) return isPrivateAddress(address.slice("::ffff:".length));
  const kind = isIP(address);
  if (kind === 4) {
    const parts = address.split(".").map((p) => Number(p));
    const [a = 0, b = 0] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (kind === 6) {
    const lower = address.toLowerCase();
    return (
      lower === "::1" || lower === "::" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:")
    );
  }
  return true;
}

function nameFromDisposition(value: string | null): string | undefined {
  if (!value) return undefined;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(value);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1]).trim() || undefined;
    } catch {
      return undefined;
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(value);
  return plain?.[1]?.trim() || undefined;
}

function nameFromUrl(url: URL): string {
  const part = url.pathname.split("/").filter(Boolean).at(-1);
  if (!part) return "file";
  try {
    return decodeURIComponent(part) || "file";
  } catch {
    return part || "file";
  }
}
