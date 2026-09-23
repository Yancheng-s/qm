import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { JSDOM } from "jsdom";
import { writeClipboardText } from "../src/clipboard.ts";

function browser(t: TestContext, clipboard?: { writeText(text: string): Promise<void> }) {
  const dom = new JSDOM('<textarea id="draft">unfinished draft</textarea><p>original selection</p>');
  for (const [key, value] of Object.entries({ document: dom.window.document, navigator: { clipboard } })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  t.after(() => dom.window.close());
  return dom.window.document;
}

test("native clipboard copies exact Unicode text without a temporary field", async (t) => {
  const writes: string[] = [];
  const doc = browser(t, {
    writeText: async (text) => {
      writes.push(text);
    },
  });
  await writeClipboardText("第一行\n第二行 😀");
  assert.deepEqual(writes, ["第一行\n第二行 😀"]);
  assert.equal(doc.querySelectorAll("textarea").length, 1);
});

for (const denied of [false, true]) {
  test(`copy restores draft focus and selection when native clipboard is ${denied ? "denied" : "unavailable"}`, async (t) => {
    const doc = browser(
      t,
      denied
        ? {
            writeText: async () => {
              throw new Error("denied");
            },
          }
        : undefined,
    );
    const draft = doc.querySelector<HTMLTextAreaElement>("#draft")!;
    draft.focus();
    draft.setSelectionRange(2, 8, "backward");
    let copied = "";
    Object.defineProperty(doc, "execCommand", {
      value: (command: string) => {
        assert.equal(command, "copy");
        const field = doc.activeElement as HTMLTextAreaElement;
        assert.notEqual(field, draft);
        assert.equal(field.readOnly, true);
        copied = field.value.slice(field.selectionStart, field.selectionEnd);
        return true;
      },
    });
    await writeClipboardText("完整文字\n下一行");
    assert.equal(copied, "完整文字\n下一行");
    assert.equal(doc.activeElement, draft);
    assert.equal(draft.value, "unfinished draft");
    assert.deepEqual([draft.selectionStart, draft.selectionEnd, draft.selectionDirection], [2, 8, "backward"]);
    assert.equal(doc.querySelectorAll("textarea").length, 1);
  });
}

test("failed legacy copy rejects and restores the existing text selection", async (t) => {
  const doc = browser(t);
  const range = doc.createRange();
  range.selectNodeContents(doc.querySelector("p")!);
  doc.getSelection()!.addRange(range);
  Object.defineProperty(doc, "execCommand", { value: () => false });
  await assert.rejects(writeClipboardText("not copied"), /无法写入剪贴板/);
  assert.equal(doc.getSelection()!.toString(), "original selection");
  assert.equal(doc.querySelectorAll("textarea").length, 1);
});
