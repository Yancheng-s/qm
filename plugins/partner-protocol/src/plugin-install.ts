import { asObject, stringField, type CoreCall } from "./core-client.ts";
import { loadPluginPackage, pluginOrders, type PluginPackage, type PluginSource } from "./plugin-package.ts";

export interface PluginInstaller {
  sources: ReadonlyMap<string, PluginSource>;
  admin: CoreCall;
  orgId: string;
  load?: typeof loadPluginPackage;
}

export interface PreparedPlugin {
  pkg: PluginPackage;
  packId: string;
  orders: string;
}

export async function preparePlugin(
  installer: PluginInstaller,
  key: string,
  extraOrders?: string,
): Promise<PreparedPlugin> {
  const source = installer.sources.get(key);
  if (!source) throw new Error("plugin source is not configured");
  const pkg = await (installer.load ?? loadPluginPackage)(key, source);
  pluginOrders(pkg, "pending", extraOrders);
  const registered = await installer.admin("POST", "/v1/admin/skill-packs", {
    url: /^[A-Za-z]:[\\/]/.test(source.url) ? `/${source.url.replaceAll("\\", "/")}` : source.url,
    ref: pkg.commit,
    subset: pkg.skills,
    trustTier: "internal",
  });
  if (!registered.ok || registered.status !== 200)
    throw new Error("plugin registration failed; check administrator access and Git credentials");
  const packId = stringField(asObject(registered.json)?.pack, "id");
  if (!packId) throw new Error("plugin registration returned no pack id");
  const catalog = await installer.admin("GET", `/v1/admin/skill-packs/${encodeURIComponent(packId)}/catalog`);
  if (!catalog.ok || catalog.status !== 200) throw new Error("QM could not read the pinned plugin repository");
  const bundlePaths = asObject(catalog.json)?.bundlePaths;
  if (
    !Array.isArray(bundlePaths) ||
    Object.values(pkg.manifest.agents).some((agent) => !bundlePaths.includes(agent.instructions))
  )
    throw new Error("role documents must be available as shared pack files");
  const candidates = asObject(catalog.json)?.candidates;
  if (
    !Array.isArray(candidates) ||
    !pkg.skills.every((name) =>
      candidates.some((candidate) => {
        const item = asObject(candidate);
        return (
          item?.upstreamName === name &&
          item.eligible === true &&
          stringField(asObject(item.normalized)?.manifest, "name") === name
        );
      }),
    )
  )
    throw new Error("QM catalog is missing eligible skills with matching manifest names");
  return { pkg, packId, orders: pluginOrders(pkg, packId, extraOrders) };
}

export async function importProjectPlugin(
  installer: PluginInstaller,
  prepared: PreparedPlugin,
  core: CoreCall,
  principalId: string,
  scopeId: string,
): Promise<void> {
  const imported = await installer.admin(
    "POST",
    `/v1/admin/skill-packs/${encodeURIComponent(prepared.packId)}/import`,
    {
      selected: prepared.pkg.skills,
      scopeIds: [scopeId],
    },
  );
  if (!imported.ok || imported.status !== 200) throw new Error("plugin skill import failed");
  const listed = await core("GET", `/v1/skills?includeShadowed=1&principalId=${encodeURIComponent(principalId)}`);
  const skills = listed.ok && listed.status === 200 ? asObject(listed.json)?.skills : undefined;
  if (
    !Array.isArray(skills) ||
    !prepared.pkg.skills.every((name) =>
      skills.some((value) => {
        const skill = asObject(value);
        return (
          skill?.name === name &&
          skill.scopeId === scopeId &&
          skill.status === "published" &&
          stringField(skill.pack, "packId") === prepared.packId &&
          stringField(skill.pack, "commit") === prepared.pkg.commit
        );
      }),
    )
  )
    throw new Error("plugin import did not publish every required skill into the new project");
  if (prepared.pkg.manifest.delegation.enabled) {
    const identity = await core("GET", `/v1/principals/${encodeURIComponent(principalId)}/canonical`);
    const canonicalId = identity.ok && identity.status === 200 ? stringField(identity.json, "canonicalId") : "";
    if (!canonicalId) throw new Error("could not resolve the user identity for QM subagents");
    const enabled = await installer.admin(
      "PUT",
      `/v1/admin/scopes/${encodeURIComponent(`org:${installer.orgId}`)}/feature-flags`,
      {
        featureName: "persistent_subagents",
        scopeId: `personal:${canonicalId}`,
        on: true,
      },
    );
    if (!enabled.ok || enabled.status !== 200) throw new Error("could not enable QM subagents for this user");
  }
}
