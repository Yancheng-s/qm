export const MAX_PREVIEW_BYTES = 50 * 1024 * 1024;

export async function readPreviewBlob(href: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<Blob> {
  const request = new AbortController();
  const abort = () => request.abort();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    request.abort();
  }, 60_000);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    const response = await fetcher(href, { signal: request.signal, credentials: "same-origin", redirect: "error" });
    if (response.status === 401 || response.status === 403)
      throw new Error("没有访问权限或登录已过期，请重新登录后查看。");
    if (!response.ok)
      throw new Error(response.status === 404 ? "文件已不存在或分享已失效。" : "文件加载失败，请重试或下载文件。");
    const tooLarge = () => new Error("文件超过 50 MB，暂不支持在线预览，请下载后查看。");
    if (Number(response.headers.get("content-length")) > MAX_PREVIEW_BYTES) {
      await response.body?.cancel();
      throw tooLarge();
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("文件内容为空，无法预览。");
    const chunks: ArrayBuffer[] = [];
    let size = 0;
    try {
      while (true) {
        request.signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_PREVIEW_BYTES) throw tooLarge();
        chunks.push(value.slice().buffer);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (!size) throw new Error("文件内容为空，无法预览。");
    return new Blob(chunks, {
      type: response.headers.get("content-type")?.split(";")[0] || "application/octet-stream",
    });
  } catch (error) {
    if (timedOut) throw new Error("文件加载超时，请重试或下载文件。", { cause: error });
    if (error instanceof TypeError) throw new Error("无法读取文件，请检查网络后重试。", { cause: error });
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}
