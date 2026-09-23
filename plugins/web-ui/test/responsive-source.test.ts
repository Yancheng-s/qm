import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/shell.css", import.meta.url), "utf8");
const compactCss = css.replace(/\s+/g, " ");
const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");
const sessions = readFileSync(new URL("../src/sessions.ts", import.meta.url), "utf8");
const contexts = readFileSync(new URL("../src/contexts.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("mobile shell follows the visual viewport and device safe areas", () => {
  assert.match(page, /viewport-fit=cover/);
  assert.match(compactCss, /height: 100dvh/);
  for (const inset of ["top", "right", "bottom", "left"]) {
    assert.match(compactCss, new RegExp(`safe-area-inset-${inset}`));
  }
});

test("mobile shell hides navigation without blocking the chat", () => {
  assert.doesNotMatch(shell, /mobile-menu-btn|sidebar-scrim|main\.inert|onSidebarKeydown/);
  assert.match(
    compactCss,
    /@media \(max-width: 860px\) \{[^}]*\}\s*\.sidebar,\s*\.sidebar-resize-handle \{\s*display: none;/,
  );
  assert.match(shell, /class="main" id="main" tabindex="-1"/);
  assert.match(sessions, /data-menu-id=\$\{menuKey\}/);
  assert.match(sessions, /focusSessionMenuButton\(menuKey\)/);
});

test("the sidebar's quick actions share the navrow treatment", () => {
  assert.match(shell, /const actionRow = \([\s\S]{0,160}class="navrow"\s+type="button"/);
  assert.doesNotMatch(shell, /class="new-chat"/);
  assert.doesNotMatch(shell, /split-new-session/);
  assert.doesNotMatch(css, /(^|\n)\.new-chat[ ,:{]/);
  assert.doesNotMatch(css, /split-new-session/);
});

test("the sidebar resize handle stays accessible without a hover tooltip", () => {
  assert.match(
    shell,
    /class="sidebar-resize-handle"[\s\S]{0,200}aria-label="调整侧边栏宽度"[\s\S]{0,200}@pointerdown=\$\{startSidebarResize\}[\s\S]{0,100}@dblclick=\$\{resetSidebarWidth\}/,
  );
  assert.doesNotMatch(shell, /Drag to resize/);
});

test("the quick nav is home, search, browse; create sits under the divider", () => {
  assert.match(
    shell,
    /<nav class="nav quick-nav"[\s\S]*?navRow\("chats", ICON\.home, "首页"\)[\s\S]*?actionRow\(Search, "搜索"[\s\S]*?actionRow\(ICON\.browse, "浏览"[\s\S]*?<\/nav>/,
  );
  assert.doesNotMatch(
    shell,
    /<nav class="nav quick-nav"[\s\S]*?actionRow\(ICON\.newChat[\s\S]*?<\/nav>/,
    "create belongs below the quick-nav divider, not inside it",
  );
  assert.match(shell, /<div class="nav new-chat-nav">[\s\S]*?actionRow\(ICON\.newChat[\s\S]*?<\/div>/);
  assert.doesNotMatch(shell, /<span>Sessions<\/span>/);
  assert.doesNotMatch(shell, /navRow\("chats", ICON\.chats/);
  assert.doesNotMatch(shell, /nav-section-toggle|nav-group|navWorkspaceOpen/);
  assert.doesNotMatch(css, /\.nav-section-toggle|\.nav-group/);
});

test("impersonation mode keeps its critical exit control below the top safe area", () => {
  assert.match(compactCss, /height: calc\(38px \+ env\(safe-area-inset-top\)\)/);
  assert.match(compactCss, /padding: env\(safe-area-inset-top\)/);
  assert.match(compactCss, /margin-top: calc\(38px \+ env\(safe-area-inset-top\)\)/);
  assert.match(compactCss, /\.layout\.impersonating \{\s*--surface-safe-top: 0px;/);
});

test("shared dialogs keep their scrollable edge inside device safe areas", () => {
  assert.match(
    compactCss,
    /\.project-dialog-backdrop,\s*\.project-dialog \{[\s\S]*--dialog-pad-bottom: max\(20px, env\(safe-area-inset-bottom\)\)/,
  );
  assert.match(
    compactCss,
    /padding: var\(--dialog-pad-top\) var\(--dialog-pad-right\) var\(--dialog-pad-bottom\) var\(--dialog-pad-left\)/,
  );
  assert.match(compactCss, /max-height: calc\(100dvh - var\(--dialog-pad-top\) - var\(--dialog-pad-bottom\)\)/);
});

test("touch layouts expose row actions and preserve readable composer choices", () => {
  assert.match(compactCss, /@media \(hover: none\)\s*\{\s*\.chat-row-actions\s*\{\s*opacity:\s*1;\s*\}/);
  assert.match(compactCss, /@media \(max-width: 360px\)[\s\S]*content: attr\(data-mobile-label\)/);
  assert.match(
    compactCss,
    /\.composer-toolbar \.runtime-default-btn,[\s\S]*\.composer-toolbar \.send-btn \{\s*min-height: 44px;/,
  );
  assert.match(compactCss, /\.composer-right \.model-control \{\s*flex: 1 1 96px;/);
  assert.match(compactCss, /\.project-create-button \{\s*width: 44px;\s*height: 44px;/);
  assert.match(contexts, /project-create-button"\s+type="button"\s+aria-label="新建项目"/);
  assert.match(
    compactCss,
    /\.chat-scroll \{\s*padding-right: max\(var\(--chat-pad\), env\(safe-area-inset-right\)\);\s*padding-left: max\(var\(--chat-pad\), env\(safe-area-inset-left\)\)/,
  );
  assert.match(
    compactCss,
    /\.pane \{\s*padding: calc\(28px \+ var\(--surface-safe-top\)\) max\(28px, env\(safe-area-inset-right\)\) calc\(40px \+ env\(safe-area-inset-bottom\)\) max\(28px, env\(safe-area-inset-left\)\)/,
  );
  assert.match(
    compactCss,
    /padding: calc\(20px \+ var\(--surface-safe-top\)\) max\(14px, env\(safe-area-inset-right\)\) calc\(32px \+ env\(safe-area-inset-bottom\)\) max\(14px, env\(safe-area-inset-left\)\)/,
  );
  assert.match(compactCss, /margin: 0 auto max\(18px, calc\(10px \+ env\(safe-area-inset-bottom\)\)\)/);
  assert.match(
    compactCss,
    /\.composer-wrap \{\s*width: auto;\s*margin-right: max\(16px, calc\(10px \+ env\(safe-area-inset-right\)\)\);\s*margin-left: max\(16px, calc\(10px \+ env\(safe-area-inset-left\)\)\)/,
  );
  assert.match(
    compactCss,
    /\.composer-wrap \{\s*margin-right: calc\(10px \+ env\(safe-area-inset-right\)\);\s*margin-bottom: calc\(10px \+ env\(safe-area-inset-bottom\)\);\s*margin-left: calc\(10px \+ env\(safe-area-inset-left\)\)/,
  );
});
