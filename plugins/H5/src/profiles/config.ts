interface LibraryBinding {
  key: string;
  scopeId: string;
}

export interface ProfilesConfig {
  libraries: readonly LibraryBinding[];
  libraryPrincipalId: string;
}

export const LIBRARY_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const SCOPE_ID = /^[a-z]+:.+$/;

export function readConfig(env: NodeJS.ProcessEnv): ProfilesConfig {
  return {
    libraries: (env.PROFILES_LIBRARY_SCOPES ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf("=");
        return {
          key: (separator < 0 ? entry : entry.slice(0, separator)).trim(),
          scopeId: separator < 0 ? "" : entry.slice(separator + 1).trim(),
        };
      }),
    libraryPrincipalId: env.PROFILES_LIBRARY_PRINCIPAL?.trim() ?? "",
  };
}

export function libraryScopeFor(cfg: ProfilesConfig, key: string): string | null {
  return cfg.libraries.find((binding) => binding.key === key)?.scopeId ?? null;
}

export function bootProblems(cfg: ProfilesConfig): string[] {
  const problems: string[] = [];
  const require = (label: string, value: string): void => {
    if (!value.trim()) problems.push(`${label} is required`);
  };
  if (!cfg.libraries.length) problems.push("PROFILES_LIBRARY_SCOPES is required (<key>=<scopeId>, comma separated)");
  const seen = new Set<string>();
  const scopeOwners = new Map<string, string>();
  for (const binding of cfg.libraries) {
    if (!binding.scopeId) {
      problems.push(`PROFILES_LIBRARY_SCOPES binding "${binding.key}" must be <key>=<scopeId>`);
      continue;
    }
    if (!LIBRARY_KEY.test(binding.key)) {
      problems.push(`PROFILES_LIBRARY_SCOPES key "${binding.key}" must match ${LIBRARY_KEY.source}`);
      continue;
    }
    if (seen.has(binding.key)) {
      problems.push(`PROFILES_LIBRARY_SCOPES binds "${binding.key}" twice`);
      continue;
    }
    seen.add(binding.key);
    if (!SCOPE_ID.test(binding.scopeId)) {
      problems.push(`PROFILES_LIBRARY_SCOPES binding "${binding.key}" needs a scope id like group:<project scope>`);
      continue;
    }
    const owner = scopeOwners.get(binding.scopeId);
    if (owner) {
      problems.push(
        `PROFILES_LIBRARY_SCOPES binds "${binding.key}" and "${owner}" to the same scope ${binding.scopeId}`,
      );
      continue;
    }
    scopeOwners.set(binding.scopeId, binding.key);
  }
  require("PROFILES_LIBRARY_PRINCIPAL", cfg.libraryPrincipalId);
  return problems;
}
