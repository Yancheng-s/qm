import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface SkillInput {
  name: string;
  description: string;
  body: string;
}

export async function loadSkills(file: string): Promise<SkillInput[]> {
  if (!file) return [];
  const text = await readFile(resolve(file), "utf8");
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error(`${file} must contain a JSON array of skills`);
  return parsed
    .map((entry) => {
      if (typeof entry !== "object" || entry === null) return null;
      const item = entry as Record<string, unknown>;
      if (typeof item.name !== "string" || typeof item.description !== "string" || typeof item.body !== "string")
        return null;
      return { name: item.name, description: item.description, body: item.body };
    })
    .filter((entry): entry is SkillInput => entry !== null);
}
