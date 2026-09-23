import { brandName } from "./ui.ts";

export function updateDocumentTitle(assistantName?: string): void {
  document.title =
    assistantName ||
    document.querySelector<HTMLMetaElement>('meta[name="initial-assistant-name"]')?.content ||
    brandName();
}
