import { getTranslations, setTranslations } from "@mariozechner/mini-lit/dist/i18n.js";
const chinese = {
  Copy: "复制",
  "Copy code": "复制代码",
  "Copied!": "已复制！",
  Download: "下载",
  Close: "关闭",
  Preview: "预览",
  Code: "代码",
  "Loading...": "加载中…",
  "Select an option": "请选择",
  "Mode 1": "模式一",
  "Mode 2": "模式二",
  Required: "必填",
  Optional: "可选",
  "Input Required": "需要输入",
  Cancel: "取消",
  Confirm: "确认",
  Remove: "移除",
  Document: "文档",
  Presentation: "演示文稿",
  Spreadsheet: "电子表格",
  Text: "文本",
  "Error loading file": "加载文件出错",
  "No text content available": "暂无文本内容",
  "No content available": "暂无内容",
  "Failed to fetch file": "获取文件失败",
  "Invalid source type": "文件来源类型无效",
  "Failed to load PDF": "加载 PDF 失败",
  "Failed to load document": "加载文档失败",
  "Failed to load spreadsheet": "加载电子表格失败",
  "Failed to display text content": "显示文本内容失败",
};
function applyComponentLanguage(): void {
  const messages = { ...getTranslations().en, ...chinese };
  setTranslations({ en: messages, de: messages, zh: messages, "zh-CN": messages });
}

applyComponentLanguage();

export async function loadPiWebUi() {
  const components = await import("@earendil-works/pi-web-ui");
  applyComponentLanguage();
  return components;
}
