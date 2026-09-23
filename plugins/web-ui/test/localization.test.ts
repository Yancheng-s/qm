import assert from "node:assert/strict";
import test from "node:test";
import { getTranslations } from "@mariozechner/mini-lit/dist/i18n.js";
import "../src/component-language.ts";
import { displayStatus, scopeTypeLabel } from "../src/display-labels.ts";

test("component actions use Chinese even with a previously stored language", () => {
  for (const language of ["en", "de", "zh", "zh-CN"]) {
    const messages = getTranslations()[language]!;
    assert.equal(messages["Copy code"], "复制代码");
    assert.equal(messages["Copied!"], "已复制！");
    assert.equal(messages.Download, "下载");
    assert.equal(messages.Cancel, "取消");
    assert.equal(messages["Failed to load PDF"], "加载 PDF 失败");
  }
});

test("status and scope labels preserve unknown server values", () => {
  assert.equal(displayStatus("running"), "运行中");
  assert.equal(displayStatus("archived"), "已归档");
  assert.equal(displayStatus(null), "未知");
  assert.equal(displayStatus("vendor-status"), "vendor-status");
  assert.equal(scopeTypeLabel("personal"), "个人");
  assert.equal(scopeTypeLabel("channel"), "频道");
  assert.equal(scopeTypeLabel("vendor-scope"), "vendor-scope");
});
