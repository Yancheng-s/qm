import type { Api, Model } from "@earendil-works/pi-ai";

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max" | "ultracode" | "auto";

export const EFFORT_LEVELS: Array<{ value: EffortLevel; label: string }> = [
  { value: "auto", label: "自动" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "极高" },
  { value: "max", label: "最高" },
  { value: "ultracode", label: "超强编程" },
];

export function effortLabel(level: EffortLevel): string {
  return EFFORT_LEVELS.find((option) => option.value === level)?.label ?? level;
}

export function harnessSupportsEffort(harnessId: string): boolean {
  return harnessId === "pi" || harnessId === "codex" || harnessId === "claude";
}

export function harnessSupportsFastMode(harnessId: string): boolean {
  return harnessId === "pi" || harnessId === "claude" || harnessId === "codex";
}

export function harnessSupportsSteer(harnessId: string): boolean {
  return harnessId === "pi" || harnessId === "claude" || harnessId === "codex" || harnessId === "opencode";
}

export function defaultEffortForModel(model: Model<Api> | undefined): EffortLevel {
  const provider = String(model?.provider ?? model?.api ?? "").toLowerCase();
  return provider.includes("anthropic") ? "low" : "auto";
}
