import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { problem, sendProblem, sendText } from "../../transport.ts";
import type { Ctx } from "../index.ts";

const ASSET_TYPES: ReadonlyMap<string, string> = new Map([
  ["main.js", "text/javascript; charset=utf-8"],
  ["styles.css", "text/css; charset=utf-8"],
]);

const ASSETS = new Map(
  [...ASSET_TYPES].map(([name, contentType]) => [
    name,
    {
      contentType,
      body: readFileSync(fileURLToPath(new URL(`../../../web/dist/assets/${name}`, import.meta.url)), "utf8"),
    },
  ]),
);

export async function handleChatAsset(c: Ctx): Promise<void> {
  const asset = ASSETS.get(c.params.name ?? "");
  if (!asset) return sendProblem(c.res, problem(404, "not_found", "unknown chat asset"));
  sendText(c.res, 200, asset.contentType, asset.body);
}
