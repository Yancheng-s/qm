export function installImageGestures(stage: HTMLElement, visual: HTMLElement): () => void {
  const win = stage.ownerDocument.defaultView!;
  const pointers = new Map<number, { x: number; y: number }>();
  let scale = 1;
  let x = 0;
  let y = 0;
  let frame = 0;
  let timer = 0;
  let lastTap = 0;
  let moved = false;
  let start = { x: 0, y: 0, distance: 1, scale: 1, offsetX: 0, offsetY: 0 };

  function paint(): void {
    if (frame) return;
    frame = win.requestAnimationFrame(() => {
      frame = 0;
      const maxX = Math.max(0, (visual.offsetWidth * scale - stage.clientWidth) / 2);
      const maxY = Math.max(0, (visual.offsetHeight * scale - stage.clientHeight) / 2);
      x = Math.max(-maxX, Math.min(maxX, x));
      y = Math.max(-maxY, Math.min(maxY, y));
      visual.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
    });
  }

  function center() {
    const points = [...pointers.values()].slice(0, 2);
    const first = points[0]!;
    const second = points[1] ?? first;
    const rect = stage.getBoundingClientRect();
    return {
      x: (first.x + second.x) / 2 - rect.left - rect.width / 2,
      y: (first.y + second.y) / 2 - rect.top - rect.height / 2,
      distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
    };
  }

  function rebase(): void {
    if (pointers.size) start = { ...center(), scale, offsetX: x, offsetY: y };
  }

  function down(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.stopImmediatePropagation();
    win.clearTimeout(timer);
    if (!pointers.size) moved = false;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size > 1) {
      moved = true;
      lastTap = 0;
    }
    stage.setPointerCapture(event.pointerId);
    rebase();
  }

  function move(event: PointerEvent): void {
    event.stopImmediatePropagation();
    if (!pointers.has(event.pointerId)) return;
    event.preventDefault();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const current = center();
    if (Math.hypot(current.x - start.x, current.y - start.y) > 6) moved = true;
    scale = pointers.size > 1 ? Math.max(1, Math.min(8, (start.scale * current.distance) / start.distance)) : scale;
    const ratio = scale / start.scale;
    x = current.x - (start.x - start.offsetX) * ratio;
    y = current.y - (start.y - start.offsetY) * ratio;
    paint();
  }

  function up(event: PointerEvent): void {
    event.stopImmediatePropagation();
    if (!pointers.has(event.pointerId)) return;
    const point = center();
    pointers.delete(event.pointerId);
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    if (event.type !== "pointerup") {
      moved = true;
      lastTap = 0;
    }
    if (pointers.size) {
      rebase();
      return;
    }
    if (moved) return;
    const now = win.performance.now();
    if (lastTap && now - lastTap < 300) {
      lastTap = 0;
      const next = scale > 1 ? 1 : 2;
      x = point.x - ((point.x - x) * next) / scale;
      y = point.y - ((point.y - y) * next) / scale;
      scale = next;
      paint();
    } else {
      lastTap = now;
      if (scale === 1)
        timer = win.setTimeout(() => {
          stage.dispatchEvent(new win.CustomEvent("preview-image-close", { bubbles: true }));
        }, 300);
    }
  }

  function wheel(event: WheelEvent): void {
    event.stopImmediatePropagation();
    event.preventDefault();
    win.clearTimeout(timer);
    lastTap = 0;
    const rect = stage.getBoundingClientRect();
    const px = event.clientX - rect.left - rect.width / 2;
    const py = event.clientY - rect.top - rect.height / 2;
    let unit = 1;
    if (event.deltaMode === 1) unit = 16;
    if (event.deltaMode === 2) unit = stage.clientHeight;
    const next = Math.max(1, Math.min(8, scale * Math.exp(-event.deltaY * unit * 0.002)));
    x = px - ((px - x) * next) / scale;
    y = py - ((py - y) * next) / scale;
    scale = next;
    paint();
  }

  function swallow(event: Event): void {
    event.stopImmediatePropagation();
    event.preventDefault();
  }

  const observer = new win.ResizeObserver(paint);
  observer.observe(stage);
  observer.observe(visual);
  stage.addEventListener("pointerdown", down, true);
  stage.addEventListener("pointermove", move, true);
  stage.addEventListener("pointerup", up, true);
  stage.addEventListener("pointercancel", up, true);
  stage.addEventListener("lostpointercapture", up, true);
  stage.addEventListener("wheel", wheel, { capture: true, passive: false });
  stage.addEventListener("click", swallow, true);
  stage.addEventListener("dblclick", swallow, true);
  visual.style.willChange = "transform";
  paint();
  return () => {
    observer.disconnect();
    win.clearTimeout(timer);
    win.cancelAnimationFrame(frame);
    stage.removeEventListener("pointerdown", down, true);
    stage.removeEventListener("pointermove", move, true);
    stage.removeEventListener("pointerup", up, true);
    stage.removeEventListener("pointercancel", up, true);
    stage.removeEventListener("lostpointercapture", up, true);
    stage.removeEventListener("wheel", wheel, true);
    stage.removeEventListener("click", swallow, true);
    stage.removeEventListener("dblclick", swallow, true);
    for (const id of pointers.keys()) if (stage.hasPointerCapture(id)) stage.releasePointerCapture(id);
    pointers.clear();
    visual.style.removeProperty("will-change");
  };
}
