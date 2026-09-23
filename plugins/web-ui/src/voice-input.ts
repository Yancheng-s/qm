import { errMessage } from "../../chassis/src/errors.ts";

export function createAudioRecorder(stream: MediaStream): MediaRecorder {
  const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"].find((type) =>
    MediaRecorder.isTypeSupported(type),
  );
  if (!mimeType) throw new Error("当前浏览器不支持录音，请更换浏览器或使用键盘输入。");
  return new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64000 });
}

export function createVoiceInput(options: {
  supported: () => boolean;
  openMicrophone: () => Promise<MediaStream>;
  createRecorder: (stream: MediaStream) => MediaRecorder;
  transcribe: (audio: Blob, durationMs: number, signal: AbortSignal) => Promise<string>;
  onChange: () => void;
  onText: (text: string) => void;
}) {
  const state = {
    phase: "idle" as "idle" | "starting" | "recording" | "transcribing",
    seconds: 0,
    error: "",
  };
  let generation = 0;
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | null = null;
  let started = 0;
  let duration = 0;

  function release(): void {
    clearInterval(ticker);
    clearTimeout(deadline);
    request?.abort();
    request = null;
    const previous = recorder;
    recorder = null;
    if (previous) {
      previous.ondataavailable = previous.onstop = previous.onerror = null;
      if (previous.state !== "inactive") {
        try {
          previous.stop();
        } catch {
          void 0;
        }
      }
    }
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    state.phase = "idle";
  }

  function cancel(notify = true): void {
    generation++;
    release();
    state.error = "";
    state.seconds = 0;
    if (notify) options.onChange();
  }

  function fail(message: string): void {
    generation++;
    release();
    state.error = message;
    options.onChange();
  }

  function stop(): void {
    if (!recorder || state.phase !== "recording") return;
    duration = Date.now() - started;
    clearInterval(ticker);
    clearTimeout(deadline);
    state.phase = "transcribing";
    options.onChange();
    deadline = setTimeout(() => fail("语音识别超时，请重试。"), 60000);
    try {
      recorder.stop();
    } catch {
      fail("无法完成录音，请重试。");
    }
  }

  async function start(): Promise<void> {
    if (state.phase !== "idle") return;
    state.error = "";
    state.seconds = 0;
    if (!options.supported()) {
      fail("当前页面无法录音，请使用 HTTPS 地址和支持录音的浏览器打开。");
      return;
    }
    const attempt = ++generation;
    state.phase = "starting";
    options.onChange();
    deadline = setTimeout(() => fail("麦克风启动超时，请检查权限后重试。"), 20000);
    try {
      const acquired = await options.openMicrophone();
      if (attempt !== generation) {
        acquired.getTracks().forEach((track) => track.stop());
        return;
      }
      clearTimeout(deadline);
      stream = acquired;
      const current = options.createRecorder(acquired);
      recorder = current;
      const chunks: Blob[] = [];
      let bytes = 0;
      current.ondataavailable = ({ data }) => {
        if (attempt !== generation) return;
        bytes += data.size;
        if (bytes > 8 * 1024 * 1024) {
          fail("录音文件过大，请缩短录音后重试。");
          return;
        }
        if (data.size) chunks.push(data);
      };
      current.onerror = () => {
        if (attempt === generation) fail("录音中断，请检查麦克风后重试。");
      };
      current.onstop = async () => {
        if (attempt !== generation) return;
        if (state.phase === "recording") {
          fail("录音意外中断，请重新录音。");
          return;
        }
        acquired.getTracks().forEach((track) => track.stop());
        stream = null;
        const audio = new Blob(chunks, { type: current.mimeType });
        if (duration < 600 || !audio.size) {
          fail("录音时间太短，请重试。");
          return;
        }
        if (duration > 65000) {
          fail("录音超过 60 秒，请缩短后重试。");
          return;
        }
        request = new AbortController();
        try {
          const text = (await options.transcribe(audio, duration, request.signal)).trim();
          if (attempt !== generation) return;
          if (!text) {
            fail("没有识别到文字，请重试。");
            return;
          }
          release();
          options.onText(text);
          options.onChange();
        } catch (error) {
          if (attempt === generation) fail(errMessage(error, "语音识别失败，请重试。"));
        }
      };
      started = Date.now();
      current.start(1000);
      state.phase = "recording";
      ticker = setInterval(() => {
        state.seconds = Math.floor((Date.now() - started) / 1000);
        options.onChange();
      }, 1000);
      deadline = setTimeout(stop, 60000);
      options.onChange();
    } catch (error) {
      if (attempt !== generation) return;
      const name = error instanceof Error ? error.name : "";
      const messages: Record<string, string> = {
        NotAllowedError: "麦克风权限未开启，请在浏览器设置中允许使用麦克风后重试。",
        NotFoundError: "没有找到麦克风，请检查设备。",
        NotReadableError: "麦克风可能被其他应用占用，请关闭后重试。",
      };
      fail(messages[name] ?? errMessage(error, "无法启动录音，请重试。"));
    }
  }

  return { state, start, stop, cancel };
}
