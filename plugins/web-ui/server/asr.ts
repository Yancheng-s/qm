import type { IncomingMessage, ServerResponse } from "node:http";
import { json, readBody, PayloadTooLargeError } from "../../chassis/src/http.ts";

const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const AUDIO_TYPES: Record<string, string> = {
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
};

export async function handleAsr(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader("cache-control", "no-store");
  if (req.headers.origin) {
    try {
      if (new URL(req.headers.origin).host !== req.headers.host) {
        json(res, 403, { message: "不允许跨站提交录音。" });
        return;
      }
    } catch {
      json(res, 403, { message: "请求来源无效。" });
      return;
    }
  }
  const endpoint = process.env.WEB_UI_ASR_URL?.trim();
  const model = process.env.WEB_UI_ASR_MODEL?.trim();
  const apiKey = process.env.WEB_UI_ASR_API_KEY?.trim();
  if (!endpoint || !model || !apiKey) {
    json(res, 503, { message: "语音识别服务尚未配置，请联系管理员。" });
    return;
  }
  let target: URL;
  try {
    target = new URL(endpoint);
    if (
      target.username ||
      target.password ||
      target.search ||
      target.hash ||
      (target.protocol !== "https:" &&
        !(target.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)))
    )
      throw new Error();
    if (!target.pathname.endsWith("/chat/completions") && !target.pathname.endsWith("/audio/transcriptions"))
      throw new Error();
  } catch {
    json(res, 503, { message: "语音识别服务配置有误，请联系管理员。" });
    return;
  }
  if (!req.headers["content-type"]?.startsWith("application/json")) {
    json(res, 415, { message: "录音请求格式不支持。" });
    return;
  }
  let input: { audio?: unknown; mimeType?: unknown; durationMs?: unknown };
  try {
    input = JSON.parse(await readBody(req, Math.ceil(MAX_AUDIO_BYTES / 3) * 4 + 1024));
    if (!input || typeof input !== "object") throw new Error();
  } catch (error) {
    json(res, error instanceof PayloadTooLargeError ? 413 : 400, {
      message: error instanceof PayloadTooLargeError ? "录音文件过大，请缩短录音。" : "录音数据无效。",
    });
    return;
  }
  const mime = typeof input.mimeType === "string" ? input.mimeType.split(";")[0]!.trim().toLowerCase() : "";
  if (
    !Object.hasOwn(AUDIO_TYPES, mime) ||
    typeof input.audio !== "string" ||
    !input.audio ||
    input.audio.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(input.audio) ||
    typeof input.durationMs !== "number" ||
    !Number.isFinite(input.durationMs) ||
    input.durationMs < 600 ||
    input.durationMs > 65000
  ) {
    json(res, 400, { message: "录音格式或时长无效，请重新录音（最长 60 秒）。" });
    return;
  }
  const bytes = Buffer.from(input.audio, "base64");
  if (!bytes.length || bytes.length > MAX_AUDIO_BYTES) {
    json(res, 413, { message: "录音文件过大或为空，请重新录音。" });
    return;
  }
  const chatProtocol = target.pathname.endsWith("/chat/completions");
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  let body: string | FormData;
  if (chatProtocol) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({
      model,
      stream: false,
      messages: [
        {
          role: "user",
          content: [{ type: "input_audio", input_audio: { data: `data:${mime};base64,${input.audio}` } }],
        },
      ],
    });
  } else {
    body = new FormData();
    body.set("model", model);
    body.set("file", new Blob([bytes], { type: mime }), `recording.${AUDIO_TYPES[mime]}`);
    body.set("response_format", "json");
  }
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  res.on("close", abort);
  try {
    const response = await fetch(target, {
      method: "POST",
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      json(res, response.status === 429 ? 429 : 502, {
        message:
          response.status === 429 ? "语音识别请求过多，请稍后重试。" : "语音识别服务调用失败，请重试或联系管理员。",
      });
      return;
    }
    let size = 0;
    const chunks: Uint8Array[] = [];
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 128 * 1024) throw new Error("response_too_large");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    }
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const text: unknown = chatProtocol ? data?.choices?.[0]?.message?.content : data?.text;
    if (typeof text !== "string") throw new Error("invalid_response");
    if (!text.trim()) {
      json(res, 422, { message: "没有识别到文字，请重新录音。" });
      return;
    }
    json(res, 200, { text: text.trim() });
  } catch (error) {
    if (!res.destroyed && !res.writableEnded)
      json(res, error instanceof Error && error.name === "TimeoutError" ? 504 : 502, {
        message: "语音识别连接失败或超时，请重试。",
      });
  } finally {
    res.off("close", abort);
  }
}
