import { installFilePreview } from "./file-preview";
import "./file-preview.css";

installFilePreview(document, async (host, file, signal) => {
  const { mountPreview } = await import("./file-preview-renderer");
  signal.throwIfAborted();
  return mountPreview(host, file, signal);
});
