import { html, type TemplateResult } from "lit";
import { ArrowUpRight, Check } from "lucide";
import { icon } from "./ui";
import { connectorLogo } from "./connector-logo";
import { CONNECTOR_NAMES, connectorService, type ConnectorLink } from "./connector-link";

export function connectorCard(
  link: ConnectorLink,
  connected = false,
  withReturnTo: (url: string) => string = (url) => url,
): TemplateResult {
  const composio = link.provider === "composio";
  const name = CONNECTOR_NAMES[link.provider] ?? "你的账户";
  const service = connectorService(link);
  if (!composio && connected) {
    return html`<div class="connector-widget connected" role="status">
      ${connectorLogo(service)}
      <span class="connector-widget-text"><strong>已连接 ${name}</strong><small>可在对话中使用</small></span>
      <span class="connector-widget-status" aria-hidden="true">${icon(Check, 16)}</span>
    </div>`;
  }
  return html`<a
    class="connector-widget"
    href=${composio ? link.url : withReturnTo(link.url)}
    target="_blank"
    rel="noreferrer"
    title="在新标签页中打开"
  >
    ${connectorLogo(service)}
    <span class="connector-widget-text"
      ><strong>${(composio && link.label) || `连接 ${name}`}</strong> <small>授权访问 · 新标签页</small></span
    >
    <span class="connector-widget-action" aria-hidden="true">${icon(ArrowUpRight, 16)}</span>
  </a>`;
}
