export interface ProfilesConfig {
  libraryScopeId: string;
  libraryPrincipalId: string;
  skillNames: readonly string[];
}

const MAX_SKILL_NAMES = 200;

export function readConfig(env: NodeJS.ProcessEnv): ProfilesConfig {
  return {
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
  require("PROFILES_LIBRARY_SCOPE", cfg.libraryScopeId);
  require("PROFILES_LIBRARY_PRINCIPAL", cfg.libraryPrincipalId);
  return problems;
}
