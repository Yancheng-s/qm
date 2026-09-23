function copyUsingSelection(text: string): void {
  const active = document.activeElement as HTMLElement | null;
  const selection = document.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange())
    : [];
  const field = active?.matches("input, textarea") ? (active as HTMLInputElement | HTMLTextAreaElement) : null;
  const start = field?.selectionStart;
  const end = field?.selectionEnd;
  const direction = field?.selectionDirection;
  const input = document.createElement("textarea");
  input.value = text;
  input.readOnly = true;
  input.tabIndex = -1;
  input.setAttribute("aria-hidden", "true");
  input.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;pointer-events:none";
  (active?.closest("dialog[open]") ?? document.body).append(input);
  try {
    input.focus({ preventScroll: true });
    input.select();
    input.setSelectionRange(0, input.value.length);
    if (!document.execCommand?.("copy")) throw new Error("无法写入剪贴板");
  } finally {
    input.remove();
    if (active?.isConnected) active.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
    if (field?.isConnected && start != null && end != null) field.setSelectionRange(start, end, direction ?? undefined);
  }
}

export async function writeClipboardText(text: string): Promise<void> {
  if (typeof globalThis.navigator?.clipboard?.writeText === "function") {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      copyUsingSelection(text);
      return;
    }
  }
  copyUsingSelection(text);
}
