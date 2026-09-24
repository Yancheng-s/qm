import { preparePlugin, importProjectPlugin, type PluginInstaller, type PreparedPlugin } from "../../plugin-install.ts";
import { asObject, stringField, upstreamProblem, type CoreCall, type CoreOutcome } from "../../core-client.ts";
import {
  importAssembleFiles,
  parseAssembleFiles,
  type AssembleFile,
  type FileImportOutcome,
  type ImportedFile,
} from "../../file-import.ts";
import { problem, sendJson, sendProblem, type Problem } from "../../transport.ts";
import type { Ctx } from "../index.ts";

export const MAX_NAME_CHARS = 200;
export const MAX_SOUL_BYTES = 8 * 1024;
export const MAX_STANDING_ORDERS_CHARS = 20_000;

interface AssembleRequest {
  name: string;
  library?: string;
  files?: readonly AssembleFile[];
  soul?: string;
  standingOrders?: string;
}

export interface AssembleInput extends AssembleRequest {
  principalId: string;
}

export interface AssembleDeps {
  core: CoreCall;
  pluginInstaller: PluginInstaller;
  importFiles?: (input: {
    core: CoreCall;
    principalId: string;
    scopeId: string;
    files: readonly AssembleFile[];
  }) => Promise<FileImportOutcome[]>;
}

export type AssembleOutcome =
  | {
      status: "assembled";
      employee: { id: string; scopeId: string; name: string };
      plugin?: { id: string; commit: string; packId: string; entryAgent: string; delegation: boolean };
      granted: readonly string[];
      grantFailures?: readonly { name: string; error: string }[];
      soul: boolean;
      soulError?: string;
      standingOrders: boolean;
      standingOrdersError?: string;
      files: readonly ImportedFile[];
      fileFailures?: readonly { url: string; name?: string; error: string }[];
    }
  | { status: "failed"; problem: Problem };

export type AssembleParse = { ok: true; request: AssembleRequest } | { ok: false; problem: Problem };

export function parseAssembleBody(body: Record<string, unknown>): AssembleParse {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > MAX_NAME_CHARS)
    return {
      ok: false,
      problem: problem(400, "bad_request", `name is required (max ${MAX_NAME_CHARS} chars)`),
    };

  let library: string | undefined;
  if (body.library !== undefined && body.library !== null && body.library !== "") {
    if (typeof body.library !== "string")
      return { ok: false, problem: problem(400, "bad_request", "library must be a string") };
    library = body.library.trim();
  }

  const parsedFiles = parseAssembleFiles(body.files);
  if (!parsedFiles.ok) return parsedFiles;

  let soul: string | undefined;
  if (body.soul !== undefined && body.soul !== null && body.soul !== "") {
    if (typeof body.soul !== "string")
      return { ok: false, problem: problem(400, "bad_request", "soul must be a string") };
    if (Buffer.byteLength(body.soul, "utf8") > MAX_SOUL_BYTES)
      return { ok: false, problem: problem(400, "bad_request", `soul exceeds ${MAX_SOUL_BYTES} bytes`) };
    soul = body.soul;
  }

  let standingOrders: string | undefined;
  if (body.standingOrders !== undefined && body.standingOrders !== null && body.standingOrders !== "") {
    if (typeof body.standingOrders !== "string")
      return { ok: false, problem: problem(400, "bad_request", "standingOrders must be a string") };
    if (body.standingOrders.length > MAX_STANDING_ORDERS_CHARS)
      return {
        ok: false,
        problem: problem(400, "bad_request", `standingOrders exceeds ${MAX_STANDING_ORDERS_CHARS} characters`),
      };
    standingOrders = body.standingOrders;
  }

  return {
    ok: true,
    request: {
      name,
      ...(parsedFiles.files.length ? { files: parsedFiles.files } : {}),
      ...(library ? { library } : {}),
      ...(soul ? { soul } : {}),
      ...(standingOrders ? { standingOrders } : {}),
    },
  };
}

function failureMessage(outcome: CoreOutcome): string {
  if (!outcome.ok) return "core unreachable";
  return stringField(outcome.json, "error") || `core replied ${outcome.status}`;
}

function resolveLibrary(
  deps: AssembleDeps,
  requested: string | undefined,
): { key: string } | { problem: Problem } {
  const known = [...deps.pluginInstaller.sources.keys()];
  const key = requested ?? (known.length === 1 ? known[0]! : "");
  if (!key) return { problem: problem(400, "bad_request", `library is required (bound: ${known.join(", ")})`) };
  if (!deps.pluginInstaller.sources.has(key))
    return { problem: problem(400, "bad_request", `unknown library "${key}" (bound: ${known.join(", ")})`) };
  return { key };
}

export async function assembleEmployee(deps: AssembleDeps, input: AssembleInput): Promise<AssembleOutcome> {
  const library = resolveLibrary(deps, input.library);
  if ("problem" in library) return { status: "failed", problem: library.problem };

  let prepared: PreparedPlugin;
  try {
    prepared = await preparePlugin(
      deps.pluginInstaller,
      library.key,
      [input.soul, input.standingOrders].filter(Boolean).join("\n\n"),
    );
  } catch (error) {
    return {
      status: "failed",
      problem: problem(502, "plugin_prepare_failed", error instanceof Error ? error.message : "plugin preparation failed"),
    };
  }

  const created = await deps.core("POST", "/v1/projects", { principalId: input.principalId, name: input.name });
  if (!created.ok) return { status: "failed", problem: created.problem };
  if (created.status !== 201)
    return { status: "failed", problem: upstreamProblem(created.status, created.json, "project creation failed") };

  const project = asObject(created.json)?.project;
  const projectId = stringField(project, "id");
  const scopeId = stringField(project, "scopeId");
  if (!projectId || !scopeId)
    return {
      status: "failed",
      problem: upstreamProblem(created.status, created.json, "core returned a project without id/scopeId"),
    };

  const granted: string[] = [];
  try {
    await importProjectPlugin(deps.pluginInstaller, prepared, deps.core, input.principalId, scopeId);
    granted.push(...prepared.pkg.skills);
  } catch (error) {
    return {
      status: "failed",
      problem: problem(
        502,
        "plugin_install_failed",
        error instanceof Error ? error.message : "plugin installation failed",
        { employee: { id: projectId, scopeId, name: input.name }, incomplete: true },
      ),
    };
  }

  const importedFiles: ImportedFile[] = [];
  const fileFailures: { url: string; name?: string; error: string }[] = [];
  if (input.files?.length) {
    const outcomes = await (deps.importFiles ?? importAssembleFiles)({
      core: deps.core,
      principalId: input.principalId,
      scopeId,
      files: input.files,
    });
    for (const outcome of outcomes) {
      if (outcome.ok) importedFiles.push(outcome.file);
      else
        fileFailures.push({
          url: outcome.url,
          ...(outcome.name ? { name: outcome.name } : {}),
          error: outcome.error,
        });
    }
  }

  const soul = false;
  let standingOrders = false;
  let standingOrdersError: string | undefined;
  const orders = prepared.orders;
  if (orders) {
    const outcome = await deps.core("PUT", "/v1/contexts/policy", {
      principalId: input.principalId,
      scope: scopeId,
      orders,
    });
    if (outcome.ok && outcome.status === 200) standingOrders = true;
    else standingOrdersError = failureMessage(outcome);
  }

  if (!standingOrders)
    return {
      status: "failed",
      problem: problem(502, "plugin_instructions_failed", standingOrdersError ?? "plugin instructions were not saved", {
        employee: { id: projectId, scopeId, name: input.name },
        incomplete: true,
      }),
    };
  return {
    status: "assembled",
    plugin: {
      id: prepared.pkg.manifest.id,
      commit: prepared.pkg.commit,
      packId: prepared.packId,
      entryAgent: prepared.pkg.manifest.entryAgent,
      delegation: prepared.pkg.manifest.delegation.enabled,
    },
    employee: { id: projectId, scopeId, name: input.name },
    granted,
    soul,
    standingOrders,
    ...(standingOrdersError ? { standingOrdersError } : {}),
    files: importedFiles,
    ...(fileFailures.length ? { fileFailures } : {}),
  };
}

export async function handleAssemble(c: Ctx): Promise<void> {
  const parsed = parseAssembleBody(c.body);
  if (!parsed.ok) return sendProblem(c.res, parsed.problem);
  if (!c.pluginInstaller)
    return sendProblem(c.res, problem(500, "plugin_configuration_missing", "plugin sources are unavailable"));
  const outcome = await assembleEmployee(
    {
      core: c.core,
      pluginInstaller: c.pluginInstaller,
    },
    { principalId: c.principalId, ...parsed.request },
  );
  if (outcome.status === "failed") return sendProblem(c.res, outcome.problem);
  sendJson(c.res, 201, {
    employee: outcome.employee,
    ...(outcome.plugin ? { plugin: outcome.plugin } : {}),
    granted: outcome.granted,
    ...(outcome.grantFailures ? { grantFailures: outcome.grantFailures } : {}),
    soul: outcome.soul,
    standingOrders: outcome.standingOrders,
    ...(outcome.standingOrdersError ? { standingOrdersError: outcome.standingOrdersError } : {}),
    files: outcome.files,
    ...(outcome.fileFailures ? { fileFailures: outcome.fileFailures } : {}),
  });
}
