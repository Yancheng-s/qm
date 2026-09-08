import test from "node:test";
import assert from "node:assert/strict";
import { bootProblems, LIBRARY_KEY, libraryScopeFor, readConfig } from "../src/profiles/config.ts";

test("readConfig binds every key to its library scope", () => {
  const cfg = readConfig({
    PROFILES_LIBRARY_SCOPES: "xhs=group:web-project-a, ecom=group:web-project-b ",
    PROFILES_LIBRARY_PRINCIPAL: " app_admin ",
  });
  assert.deepEqual(cfg.libraries, [
    { key: "xhs", scopeId: "group:web-project-a" },
    { key: "ecom", scopeId: "group:web-project-b" },
  ]);
  assert.equal(cfg.libraryPrincipalId, "app_admin");
  assert.deepEqual(bootProblems(cfg), []);
  assert.equal(libraryScopeFor(cfg, "ecom"), "group:web-project-b");
  assert.equal(libraryScopeFor(cfg, "douyin"), null);
});

test("bootProblems reports a missing binding and a missing principal", () => {
  assert.deepEqual(bootProblems(readConfig({})), [
    "PROFILES_LIBRARY_SCOPES is required (<key>=<scopeId>, comma separated)",
    "PROFILES_LIBRARY_PRINCIPAL is required",
  ]);
});

test("bootProblems names every malformed binding", () => {
  const cfg = readConfig({
    PROFILES_LIBRARY_SCOPES: "xhs,XHS=group:a,dup=group:c,dup=group:d,blank=,loose=web-project-e,good=group:f",
    PROFILES_LIBRARY_PRINCIPAL: "app_admin",
  });
  assert.deepEqual(bootProblems(cfg), [
    'PROFILES_LIBRARY_SCOPES binding "xhs" must be <key>=<scopeId>',
    `PROFILES_LIBRARY_SCOPES key "XHS" must match ${LIBRARY_KEY.source}`,
    'PROFILES_LIBRARY_SCOPES binds "dup" twice',
    'PROFILES_LIBRARY_SCOPES binding "blank" must be <key>=<scopeId>',
    'PROFILES_LIBRARY_SCOPES binding "loose" needs a scope id like group:<project scope>',
  ]);
  assert.equal(libraryScopeFor(cfg, "good"), "group:f");
});

test("bootProblems refuses two keys bound to one scope", () => {
  const cfg = readConfig({
    PROFILES_LIBRARY_SCOPES: "xhs=group:web-project-a,alias=group:web-project-a,ecom=group:web-project-b",
    PROFILES_LIBRARY_PRINCIPAL: "app_admin",
  });
  assert.deepEqual(bootProblems(cfg), [
    'PROFILES_LIBRARY_SCOPES binds "alias" and "xhs" to the same scope group:web-project-a',
  ]);
});
