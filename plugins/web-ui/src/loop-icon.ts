import { html, type TemplateResult } from "lit";
import {
  Repeat,
  Mail,
  Zap,
  Code,
  Bug,
  Shield,
  Calendar,
  MessageSquare,
  ChartNoAxesCombined,
  CheckCircle2,
  BookOpen,
  Rocket,
  Globe,
  Heart,
  Wrench,
} from "lucide";
import { icon, slackMark } from "./ui";

export const LOOP_ICONS = [
  { id: "repeat", label: "工作流", glyph: Repeat },
  { id: "mail", label: "邮件", glyph: Mail },
  { id: "slack", label: "Slack", glyph: MessageSquare },
  { id: "zap", label: "闪电", glyph: Zap },
  { id: "code", label: "代码", glyph: Code },
  { id: "bug", label: "缺陷", glyph: Bug },
  { id: "shield", label: "盾牌", glyph: Shield },
  { id: "calendar", label: "日历", glyph: Calendar },
  { id: "message", label: "消息", glyph: MessageSquare },
  { id: "chart", label: "图表", glyph: ChartNoAxesCombined },
  { id: "check", label: "勾选", glyph: CheckCircle2 },
  { id: "book", label: "书籍", glyph: BookOpen },
  { id: "rocket", label: "火箭", glyph: Rocket },
  { id: "globe", label: "地球", glyph: Globe },
  { id: "heart", label: "爱心", glyph: Heart },
  { id: "wrench", label: "扳手", glyph: Wrench },
];

export function loopIcon(loop: { icon?: string; source?: string; sources?: string[] }, size = 16): TemplateResult {
  if (loop.icon?.startsWith("data:image/png;base64,")) {
    return html`<span class="loop-icon" aria-hidden="true"
      ><img src=${loop.icon} width=${size} height=${size} alt=""
    /></span>`;
  }
  const source = loop.source ?? loop.sources?.[0];
  const fallback = ({ gmail: "mail", slack: "slack" } as Record<string, string>)[source ?? ""] ?? "repeat";
  const choice =
    LOOP_ICONS.find((entry) => entry.id === (loop.icon ?? fallback)) ??
    LOOP_ICONS.find((entry) => entry.id === fallback)!;
  return html`<span class="loop-icon" aria-hidden="true"
    >${choice.id === "slack" ? slackMark(size) : icon(choice.glyph, size)}</span
  >`;
}

export async function readLoopIcon(file: File): Promise<string> {
  if (file.size > 2 * 1024 * 1024) throw new Error("请选择小于 2 MB 的图片。");
  if (!["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"].includes(file.type))
    throw new Error("请选择 PNG、JPEG、WebP、GIF 或 SVG 图片。");
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw new Error("无法获取此图片的有效尺寸。");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 96;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前浏览器不支持图片上传。");
    const scale = Math.min(96 / image.naturalWidth, 96 / image.naturalHeight);
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    context.drawImage(image, (96 - width) / 2, (96 - height) / 2, width, height);
    const value = canvas.toDataURL("image/png");
    if (value.length > 65_536) throw new Error("图片过于复杂，请选择更简单的图片。");
    return value;
  } finally {
    URL.revokeObjectURL(url);
  }
}
