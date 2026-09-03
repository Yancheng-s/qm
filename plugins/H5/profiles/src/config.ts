export interface ProfilesConfig {
  assembleKey: string;
  libraryScopeId: string;
  libraryPrincipalId: string;
  skillNames: readonly string[];
}

const MAX_SKILL_NAMES = 200;

export function readConfig(env: NodeJS.ProcessEnv): ProfilesConfig {
  return {
    assembleKey: env.PROFILES_ASSEMBLE_KEY?.trim() ?? "",
    libraryScopeId: env.PROFILES_LIBRARY_SCOPE?.trim() ?? "",
    libraryPrincipalId: env.PROFILES_LIBRARY_PRINCIPAL?.trim() ?? "",
    skillNames: (env.PROFILES_SKILL_NAMES ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .slice(0, MAX_SKILL_NAMES),
  };
}

export function bootProblems(cfg: ProfilesConfig): string[] {
  const problems: string[] = [];
  const require = (label: string, value: string): void => {
    if (!value.trim()) problems.push(`${label} is required`);
  };
  require("PROFILES_ASSEMBLE_KEY", cfg.assembleKey);
  require("PROFILES_LIBRARY_SCOPE", cfg.libraryScopeId);
  require("PROFILES_LIBRARY_PRINCIPAL", cfg.libraryPrincipalId);
  if (cfg.assembleKey && cfg.assembleKey.length < 32)
    problems.push("PROFILES_ASSEMBLE_KEY must be at least 32 characters");
  return problems;
}
