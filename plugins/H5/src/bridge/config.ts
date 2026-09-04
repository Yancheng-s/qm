export interface BridgeConfig {
  webUiApiUrl: string;
}

export function readConfig(env: NodeJS.ProcessEnv): BridgeConfig {
  return { webUiApiUrl: (env.WEB_UI_API_URL ?? "").trim().replace(/\/+$/, "") };
}

export function bootProblems(cfg: BridgeConfig): string[] {
  if (!cfg.webUiApiUrl)
    return ["WEB_UI_API_URL is required (web-ui server base url, e.g. http://localhost:8097)"];
  let parsed: URL;
  try {
    parsed = new URL(cfg.webUiApiUrl);
  } catch {
    return [`WEB_UI_API_URL must be an absolute url, got "${cfg.webUiApiUrl}"`];
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return [`WEB_UI_API_URL must be http(s), got "${parsed.protocol}//"`];
  return [];
}
