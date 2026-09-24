import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_TEXT_BYTES = 256_000;

export interface PluginSource {
  url: string;
  ref?: string;
}

export interface PluginAgent {
  instructions: string;
  skills: string[];
  members: string[];
}

export interface PluginManifest {
  schemaVersion: 1;
  id: string;
  mcp: string[];
  entryAgent: string;
  delegation: { enabled: boolean; provider: "qm" };
  agents: Record<string, PluginAgent>;
}

export interface PluginPackage {
  source: PluginSource;
  commit: string;
  manifest: PluginManifest;
  documents: Record<string, string>;
  skills: string[];
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object");
  return value as Record<string, unknown>;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) throw new Error("invalid plugin, agent or skill id");
  return value;
}

function names(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 50) throw new Error("expected at most 50 names");
  const result = value.map(identifier);
  if (new Set(result).size !== result.length) throw new Error("duplicate name");
  return result;
}

function documentPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9_./-]+\.md$/.test(value) ||
    value.startsWith("/") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("instructions must be a repository-relative Markdown path");
  return value;
}

export function parsePluginManifest(value: unknown): PluginManifest {
  const raw = object(value);
  if (raw.schemaVersion !== 1) throw new Error("plugin schemaVersion must be 1");
  const id = identifier(raw.id);
  const mcp = names(raw.mcp);
  const entryAgent = identifier(raw.entryAgent);
  const delegation = object(raw.delegation);
  if (typeof delegation.enabled !== "boolean" || delegation.provider !== "qm")
    throw new Error("delegation requires enabled and provider qm");
  const agents: Record<string, PluginAgent> = Object.create(null);
  const entries = Object.entries(object(raw.agents));
  if (!entries.length || entries.length > 20) throw new Error("plugin requires 1 to 20 agents");
  for (const [key, value] of entries) {
    identifier(key);
    const agent = object(value);
    agents[key] = {
      instructions: documentPath(agent.instructions),
      skills: names(agent.skills),
      members: names(agent.members ?? []),
    };
    if (!agents[key]!.skills.length) throw new Error(`agent ${key} requires at least one skill`);
  }
  if (!agents[entryAgent]) throw new Error("entryAgent is not declared");
  for (const [key, agent] of Object.entries(agents)) {
    for (const member of agent.members) {
      if (!agents[member] || member === entryAgent || key !== entryAgent)
        throw new Error("only the entry agent may delegate to declared member agents");
    }
    if (key !== entryAgent && !agents[entryAgent]!.members.includes(key))
      throw new Error(`agent ${key} is not reachable from entryAgent`);
  }
  return { schemaVersion: 1, id, mcp, entryAgent, delegation: { enabled: delegation.enabled, provider: "qm" }, agents };
}

export function parsePluginSources(raw: string): Map<string, PluginSource> {
  if (!raw.trim()) return new Map();
  return new Map(
    Object.entries(object(JSON.parse(raw))).map(([key, value]) => {
      identifier(key);
      const source = typeof value === "string" ? { url: value } : object(value);
      if (typeof source.url !== "string" || !source.url.trim()) throw new Error(`missing URL for ${key}`);
      const url = source.url.trim();
      if (!isAbsolute(url)) {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash)
          throw new Error("plugin source must be an absolute local Git path or credential-free HTTPS Git URL");
      }
      if (
        source.ref !== undefined &&
        (typeof source.ref !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,199}$/.test(source.ref))
      )
        throw new Error("invalid plugin Git ref");
      return [key, { url, ...(source.ref ? { ref: source.ref as string } : {}) }];
    }),
  );
}

async function git(args: string[]): Promise<string> {
  const result = await run("git", args, {
    timeout: 120_000,
    maxBuffer: 4_000_000,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return result.stdout;
}

export async function loadPluginPackage(key: string, source: PluginSource): Promise<PluginPackage> {
  let temporary: string | undefined;
  try {
    let repo = source.url;
    if (!isAbsolute(repo)) {
      temporary = await mkdtemp(join(tmpdir(), "partner-plugin-"));
      repo = join(temporary, "repository.git");
      await git(["-c", "http.followRedirects=false", "clone", "--bare", "--", source.url, repo]);
    }
    const commit = (
      await git(["-C", repo, "rev-parse", "--verify", "--end-of-options", `${source.ref ?? "HEAD"}^{commit}`])
    ).trim();
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("invalid Git commit");
    const listing = await git(["-C", repo, "ls-tree", "-r", "-z", commit]);
    const paths = new Map(
      listing
        .split("\0")
        .filter(Boolean)
        .map((line) => {
          const tab = line.indexOf("\t");
          return [line.slice(tab + 1), line.slice(0, tab).split(" ")[0]];
        }),
    );
    const read = async (file: string) => {
      if (!/^100(644|755)$/.test(paths.get(file) ?? "")) throw new Error(`missing regular file: ${file}`);
      const text = await git(["-C", repo, "show", `${commit}:${file}`]);
      if (Buffer.byteLength(text) > MAX_TEXT_BYTES || text.includes("\0"))
        throw new Error(`invalid text file: ${file}`);
      return text;
    };
    const manifest = parsePluginManifest(JSON.parse(await read("plugin.json")));
    if (manifest.id !== key) throw new Error("plugin id must match its configured library key");
    const documents: Record<string, string> = Object.create(null);
    for (const agent of Object.values(manifest.agents)) {
      documents[agent.instructions] = await read(agent.instructions);
      if (!documents[agent.instructions]!.trim()) throw new Error("empty role instructions");
    }
    const skills = [...new Set(Object.values(manifest.agents).flatMap((agent) => agent.skills))];
    for (const name of skills) {
      const matches = [...paths.keys()].filter(
        (file) => file.endsWith(`/${name}/SKILL.md`) || file === `${name}/SKILL.md`,
      );
      if (matches.length !== 1) throw new Error(`skill ${name} must have exactly one SKILL.md`);
      await read(matches[0]!);
    }
    return { source, commit, manifest, documents, skills };
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

export function pluginOrders(pkg: PluginPackage, packId: string, extra = ""): string {
  const { manifest } = pkg;
  const lead = manifest.agents[manifest.entryAgent]!;
  const body = pkg.documents[lead.instructions]!.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  const members = lead.members.map((id) => {
    const agent = manifest.agents[id]!;
    return `- ${id}: 文档 ${agent.instructions}；技能 ${agent.skills.join(", ")}`;
  });
  const adapter = [
    "## QM 运行适配规则",
    `插件 ${manifest.id}，版本 ${pkg.commit}，默认主理人 ${manifest.entryAgent}。`,
    manifest.mcp.length
      ? `本项目仅可调用以下 MCP Server 的工具：${manifest.mcp.join(", ")}。不调用任何其他 MCP Server，即使工具列表中显示了它们。`
      : "本项目不允许调用任何 MCP Server。即使工具列表中显示 MCP 工具，也不得调用。",
    "用户要求其他业务或其他 MCP 能力时，说明该能力不属于当前项目，建议切换到对应项目；不得尝试调用未声明的 MCP。",
    "以下规则替代角色文档中的宿主工具名称和团队创建约定，不改变业务流程。",
    "本主理人设定仅适用于接待用户的会话。收到 QM 的 subagent-task 时，按委派的员工身份执行，不扮演主理人，不继续派生代理。",
    `使用 skills 工具 action=read 读取 ${lead.skills[0]}，以返回的 Pack files 路径为共享文件根目录（pack id: ${packId}）。每轮路径可能变化，不使用本机仓库绝对路径。`,
    "员工文档是按需读取的角色定义，不是你同时承担的身份。角色技能列表属于使用约定，不改变项目权限。",
    ...members,
    ...(manifest.delegation.enabled
      ? [
          "需要委派时使用 QM session 工具的 open 操作，name 使用上述成员 ID，task 携带角色说明、完整任务、已确认上下文、交付要求和必要业务参数。无需 TeamCreate，不使用引擎原生 Agent/spawnAgent。",
          "派发前读取对应员工文档，将全文及这份 QM 适配规则放进 task。若当前主会话不能读文件，则在 task 中要求员工先用 skills read 读取其指定技能，再从 Pack files 根目录读取自己的文档后执行，不能假装已读取。",
          "员工文档中的 SendMessage 改用 session send_message，target=parent；最终答复由 QM 自动回传主理人。员工不得直接向用户交付或再次委派。后续工作使用 session followup_task，沿用同一员工角色。",
          "子代理工具不可用时如实说明，不假装创建了员工。",
        ]
      : [
          "本插件关闭委派：不使用 QM 或引擎自身的子代理工具。由主理人直接执行业务流程；涉及员工流程时先读取对应文档作为操作手册，不假装已派发。",
        ]),
  ].join("\n");
  const orders = [body, extra.trim() ? `## 项目补充要求\n${extra.trim()}` : "", adapter].filter(Boolean).join("\n\n");
  if (orders.length > 20_000) throw new Error("compiled plugin instructions exceed QM's 20000 character limit");
  return orders;
}
