import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { createVoiceInput } from "../src/voice-input.ts";

function fixture(
  transcribe: (audio: Blob, durationMs: number, signal: AbortSignal) => Promise<string> = async () => "识别的文字",
) {
  let trackStops = 0;
  let recorderStops = 0;
  const texts: string[] = [];
  const uploads: Array<{ audio: Blob; durationMs: number; signal: AbortSignal }> = [];
  const stream = {
    getTracks: () => [
      {
        stop: () => {
          trackStops++;
        },
      },
    ],
  } as unknown as MediaStream;
  const recorder = {
    mimeType: "audio/webm;codecs=opus",
    state: "inactive",
    ondataavailable: null as ((event: { data: Blob }) => void) | null,
    onstop: null as (() => void) | null,
    onerror: null as (() => void) | null,
    start() {
      this.state = "recording";
    },
    stop() {
      recorderStops++;
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["audio-bytes"]) });
      this.onstop?.();
    },
  };
  const options = {
    supported: () => true,
    openMicrophone: async () => stream,
    createRecorder: () => recorder as unknown as MediaRecorder,
    transcribe: async (audio: Blob, durationMs: number, signal: AbortSignal) => {
      uploads.push({ audio, durationMs, signal });
      return transcribe(audio, durationMs, signal);
    },
    onChange() {},
    onText: (text: string) => texts.push(text),
  };
  const voice = createVoiceInput(options);
  return {
    voice,
    recorder,
    stream,
    options,
    texts,
    uploads,
    trackStops: () => trackStops,
    recorderStops: () => recorderStops,
  };
}

test("stopping captures the final audio chunk and returns text only after recognition", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1000 });
  const f = fixture();
  await f.voice.start();
  assert.equal(f.voice.state.phase, "recording");
  assert.deepEqual(f.texts, []);
  t.mock.timers.tick(2200);
  f.voice.stop();
  await setImmediate();
  assert.equal(f.uploads.length, 1);
  assert.equal(await f.uploads[0]!.audio.text(), "audio-bytes");
  assert.equal(f.uploads[0]!.durationMs, 2200);
  assert.equal(f.trackStops(), 1);
  assert.deepEqual(f.texts, ["识别的文字"]);
  assert.equal(f.voice.state.phase, "idle");
});

test("cancel releases the microphone and never uploads the recording", async () => {
  const f = fixture();
  await f.voice.start();
  f.voice.cancel();
  assert.equal(f.recorderStops(), 1);
  assert.equal(f.trackStops(), 1);
  assert.equal(f.uploads.length, 0);
  assert.deepEqual(f.texts, []);
  assert.equal(f.voice.state.phase, "idle");
});

test("cancel while waiting for permission releases the late microphone stream", async () => {
  const f = fixture();
  let allow!: (stream: MediaStream) => void;
  f.options.openMicrophone = () =>
    new Promise((resolve) => {
      allow = resolve;
    });
  const pending = f.voice.start();
  f.voice.cancel();
  allow(f.stream);
  await pending;
  assert.equal(f.trackStops(), 1);
  assert.equal(f.recorder.state, "inactive");
  assert.equal(f.uploads.length, 0);
});

test("cancel during transcription aborts the request and ignores late text", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1000 });
  let resolveText!: (value: string) => void;
  const f = fixture(
    () =>
      new Promise((resolve) => {
        resolveText = resolve;
      }),
  );
  await f.voice.start();
  t.mock.timers.tick(1000);
  f.voice.stop();
  f.voice.cancel();
  assert.equal(f.uploads[0]!.signal.aborted, true);
  resolveText("不应回填");
  await setImmediate();
  assert.deepEqual(f.texts, []);
});

test("recordings stop automatically at sixty seconds", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1000 });
  const f = fixture();
  await f.voice.start();
  t.mock.timers.tick(60000);
  await setImmediate();
  assert.equal(f.recorderStops(), 1);
  assert.equal(f.uploads[0]!.durationMs, 60000);
  assert.equal(f.voice.state.phase, "idle");
});

test("short audio, denied permissions, and unsupported browsers do not upload", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1000 });
  const f = fixture();
  await f.voice.start();
  f.voice.stop();
  assert.match(f.voice.state.error, /太短/);
  assert.equal(f.uploads.length, 0);
  f.options.openMicrophone = async () => {
    throw new DOMException("denied", "NotAllowedError");
  };
  await f.voice.start();
  assert.match(f.voice.state.error, /权限/);
  f.options.supported = () => false;
  await f.voice.start();
  assert.match(f.voice.state.error, /HTTPS/);
});

test("transcription failure releases resources and permits retry", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1000 });
  const f = fixture(async () => {
    throw new Error("服务尚未配置");
  });
  await f.voice.start();
  t.mock.timers.tick(1000);
  f.voice.stop();
  await setImmediate();
  assert.match(f.voice.state.error, /服务尚未配置/);
  assert.equal(f.voice.state.phase, "idle");
  await f.voice.start();
  assert.equal(f.voice.state.error, "");
  assert.equal(f.voice.state.phase, "recording");
  f.voice.cancel();
});
