export interface Renderer {
  addBubble(role: "user" | "ai", text: string, pending?: boolean): HTMLSpanElement;
  markError(span: HTMLSpanElement, text: string): void;
  scrollBottom(): void;
  update(span: HTMLSpanElement, text: string): void;
}

export function createRenderer(msgs: HTMLElement): Renderer {
  const scrollBottom = () => {
    msgs.scrollTop = msgs.scrollHeight;
  };
  const addBubble = (role: "user" | "ai", text: string, pending = false) => {
    const div = document.createElement("div");
    div.className = `bub ${role}${pending ? " pending" : ""}`;
    const span = document.createElement("span");
    span.className = "txt";
    span.textContent = text;
    div.appendChild(span);
    msgs.appendChild(div);
    scrollBottom();
    return span;
  };
  const markError = (span: HTMLSpanElement, text: string) => {
    span.textContent = text;
    span.parentElement?.setAttribute("data-err", "1");
    span.parentElement?.classList.remove("pending");
  };
  const update = (span: HTMLSpanElement, text: string) => {
    span.textContent = text;
    span.parentElement?.classList.remove("pending");
    scrollBottom();
  };
  return { addBubble, markError, scrollBottom, update };
}
