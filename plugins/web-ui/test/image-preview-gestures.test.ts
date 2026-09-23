import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { installImageGestures } from "../src/image-preview-gestures.ts";

function fixture() {
  const dom = new JSDOM('<div id="stage"><img></div>', { pretendToBeVisual: true });
  const win = dom.window;
  const stage = win.document.querySelector<HTMLElement>("#stage")!;
  const image = stage.querySelector("img")!;
  Object.defineProperties(stage, { clientWidth: { value: 400 }, clientHeight: { value: 400 } });
  Object.defineProperties(image, { offsetWidth: { value: 400 }, offsetHeight: { value: 400 } });
  stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 400 }) as DOMRect;
  stage.setPointerCapture = () => {};
  stage.hasPointerCapture = () => false;
  stage.releasePointerCapture = () => {};
  Object.defineProperty(win, "ResizeObserver", {
    value: class {
      observe() {}
      disconnect() {}
    },
  });
  const dispose = installImageGestures(stage, image);
  function pointer(type: string, id: number, x: number, y: number) {
    const event = new win.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true });
    Object.defineProperty(event, "pointerId", { value: id });
    image.dispatchEvent(event);
  }
  const frame = () => new Promise((resolve) => win.requestAnimationFrame(resolve));
  return { dom, win, stage, image, dispose, pointer, frame };
}

test("pinch scales continuously around the fingers and continues panning after one finger lifts", async () => {
  const f = fixture();
  f.pointer("pointerdown", 1, 100, 200);
  f.pointer("pointerdown", 2, 200, 200);
  f.pointer("pointermove", 2, 211, 200);
  await f.frame();
  assert.match(f.image.style.transform, /scale\(1\.11\)/);
  assert.ok(Math.abs(Number(f.image.style.transform.match(/translate3d\(([^p]+)/)![1]) - 11) < 0.001);
  f.pointer("pointermove", 2, 237, 200);
  await f.frame();
  assert.match(f.image.style.transform, /scale\(1\.37\)/);
  f.pointer("pointerup", 2, 237, 200);
  f.pointer("pointermove", 1, 90, 200);
  await f.frame();
  assert.ok(Math.abs(Number(f.image.style.transform.match(/translate3d\(([^p]+)/)![1]) - 27) < 0.001);
  f.dispose();
  f.dom.window.close();
});

test("small wheel deltas zoom without thresholds and do not reach the legacy handler", async () => {
  const f = fixture();
  let legacyCalls = 0;
  f.stage.addEventListener("wheel", () => legacyCalls++);
  f.image.dispatchEvent(
    new f.win.WheelEvent("wheel", { deltaY: -1, clientX: 200, clientY: 200, bubbles: true, cancelable: true }),
  );
  await f.frame();
  const scale = Number(f.image.style.transform.match(/scale\(([^)]+)/)![1]);
  assert.ok(scale > 1 && scale < 1.01);
  assert.equal(legacyCalls, 0);
  f.dispose();
  f.dom.window.close();
});

test("dragging does not close, tapping closes, and disposing cancels pending close", async () => {
  const f = fixture();
  let closed = 0;
  f.stage.addEventListener("preview-image-close", () => closed++);
  f.pointer("pointerdown", 1, 100, 100);
  f.pointer("pointermove", 1, 150, 100);
  f.pointer("pointerup", 1, 150, 100);
  await new Promise((resolve) => setTimeout(resolve, 330));
  assert.equal(closed, 0);
  f.pointer("pointerdown", 1, 100, 100);
  f.pointer("pointerup", 1, 100, 100);
  await new Promise((resolve) => setTimeout(resolve, 330));
  assert.equal(closed, 1);
  f.pointer("pointerdown", 1, 100, 100);
  f.pointer("pointerup", 1, 100, 100);
  f.dispose();
  await new Promise((resolve) => setTimeout(resolve, 330));
  assert.equal(closed, 1);
  f.dom.window.close();
});
