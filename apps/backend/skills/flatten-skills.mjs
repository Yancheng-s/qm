import { readdir, readFile, stat } from "node:fs/promises";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const XHS = join(here, "xhs");
const OUT = join(here, "skills.json");

const MAX_DESC = 500;
const MAX_BODY = 131_072;

const LANG = { ".py": "python", ".mjs": "javascript", ".js": "javascript", ".sh": "bash", ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".html": "html", ".md": "markdown" };

function fence(lang, text) {
  return "````" + (lang ? lang : "") + "\n" + text.replace(/````\s*$/, "") + "\n````";
}

function parseFrontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (!m) return { name: "", description: "", body: md };
  const fm = m[1];
  const body = md.slice(m[0].length);
  const pick = (key) => {
    const line = fm.split(/\r?\n/).find((l) => l.startsWith(key + ":"));
    return line ? line.slice(key.length + 1).trim() : "";
  };
  return { name: pick("name"), description: pick("description"), body };
}

async function listFiles(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

async function buildSkill(skillDir) {
  const raw = await readFile(join(skillDir, "SKILL.md"), "utf8");
  const { name, description, body } = parseFrontmatter(raw);
  const parts = [body.trim()];

  for (const sub of ["references", "scripts", "assets"]) {
    const dir = join(skillDir, sub);
    try {
      if (!(await stat(dir)).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of await listFiles(dir)) {
      const ext = extname(file).toLowerCase();
      if (sub === "references" && ext !== ".md") continue;
      if (sub === "scripts" && ![".py", ".mjs", ".js", ".sh"].includes(ext)) continue;
      if (sub === "assets" && ![".html", ".json", ".yaml", ".yml"].includes(ext)) continue;
      const text = await readFile(join(dir, file), "utf8");
      const label = sub === "references" ? "参考" : sub === "scripts" ? "脚本" : "资源";
      parts.push(`\n\n---\n\n### ${label}：${sub}/${file}\n\n${fence(LANG[ext], text)}`);
    }
  }

  let fullBody = parts.join("");
  let desc = description.replace(/\s+/g, " ").trim();
  let descTruncated = false;
  if ([...desc].length > MAX_DESC) {
    desc = [...desc].slice(0, MAX_DESC - 1).join("") + "…";
    descTruncated = true;
  }
  let bodyTruncated = false;
  if (Buffer.byteLength(fullBody, "utf8") > MAX_BODY) {
    fullBody = fullBody.slice(0, MAX_BODY - 20) + "\n\n[truncated]";
    bodyTruncated = true;
  }
  return { name, description: desc, body: fullBody, _bodyBytes: Buffer.byteLength(fullBody, "utf8"), _descTruncated: descTruncated, _bodyTruncated: bodyTruncated };
}

const dirs = (await readdir(XHS, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith("."));
const skills = [];
for (const d of dirs.sort((a, b) => a.name.localeCompare(b.name))) {
  try {
    await stat(join(XHS, d.name, "SKILL.md"));
  } catch {
    continue;
  }
  skills.push(await buildSkill(join(XHS, d.name)));
}

const payload = skills.map(({ name, description, body }) => ({ name, description, body }));
const json = JSON.stringify(payload);
await writeFileSafe(OUT, json);

async function writeFileSafe(path, text) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, text, "utf8");
}

console.log(`flattened ${skills.length} skills -> ${OUT}`);
let total = 0;
for (const s of skills) {
  total += s._bodyBytes;
  const flags = [s._descTruncated ? "desc-truncated" : "", s._bodyTruncated ? "BODY-TRUNCATED" : ""].filter(Boolean).join(" ");
  console.log(`  ${s.name.padEnd(28)} body=${String(s._bodyBytes).padStart(6)}B desc=${String([...s.description].length).padStart(3)} ${flags}`);
}
const assembleBytes = Buffer.byteLength(JSON.stringify({ userId: "u", name: "n", skills: payload, soul: "" }), "utf8");
console.log(`sum(body)=${total}B  skills.json=${Buffer.byteLength(json)}B  ~assembleBody=${assembleBytes}B (limit 524288)`);
if (assembleBytes > 524_288) console.log("!! assemble body exceeds 512KB — split into assemble + POST /v1/skills");
for (const s of skills) if (s._bodyBytes > MAX_BODY) console.log(`!! ${s.name} body exceeds 128KB`);
