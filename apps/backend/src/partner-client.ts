import { createHmac } from "node:crypto";

export interface PartnerClientOptions {
  gatewayUrl: string;
  partnerId: string;
  partnerSecret: string;
}

export type PartnerOutcome = { ok: true; status: number; json: unknown } | { ok: false; status: number; json: unknown };

export interface PartnerClient {
  call(method: string, pathWithQuery: string, body?: unknown): Promise<PartnerOutcome>;
}

export function partnerHeaders(
  options: PartnerClientOptions,
  method: string,
  pathWithQuery: string,
  rawBody: string,
): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000);
  const canonical = `${method}\n${pathWithQuery}\n${rawBody}`;
  const signature = "v0=" + createHmac("sha256", options.partnerSecret).update(`v0:${ts}:${canonical}`).digest("hex");
  return {
    "x-partner-id": options.partnerId,
    "x-timestamp": String(ts),
    "x-signature": signature,
  };
}

export function createPartnerClient(options: PartnerClientOptions): PartnerClient {
  const sign = (method: string, pathWithQuery: string, rawBody: string): Record<string, string> => ({
    ...partnerHeaders(options, method, pathWithQuery, rawBody),
    ...(rawBody ? { "content-type": "application/json" } : {}),
  });

  return {
    async call(method, pathWithQuery, body) {
      const raw = body === undefined ? "" : JSON.stringify(body);
      const response = await fetch(`${options.gatewayUrl}${pathWithQuery}`, {
        method,
        headers: sign(method, pathWithQuery, raw),
        ...(raw ? { body: raw } : {}),
      });
      const text = await response.text();
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text };
      }
      return response.ok ? { ok: true, status: response.status, json } : { ok: false, status: response.status, json };
    },
  };
}
