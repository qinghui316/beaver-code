import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lintUiStyles } from "../../scripts/lint-ui-styles.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("UI style drift lint", () => {
  it.each(["matching", "weak", "missing"])("allows only the shared quiet text contract with platform focus retained: %s", async (platformFocus) => {
    const root = await createFixture({
      "src/web/src/main.tsx": 'import "./styles/index.css";',
      "src/web/src/styles/index.css": '@import "./base.css";',
      "src/web/src/styles/base.css": [
        'textarea:focus, input:not([type]):focus, input:is([type="text"], [type="search"], [type="email"], [type="url"], [type="password"], [type="tel"], [type="number"]):focus { outline: none; }',
        platformFocus === "matching" ? '@media (forced-colors: active) { textarea:focus, input:not([type]):focus, input:is([type="text"], [type="search"], [type="email"], [type="url"], [type="password"], [type="tel"], [type="number"]):focus { outline: 1px solid Highlight; } }'
          : platformFocus === "weak" ? '@media (forced-colors: active) { textarea:focus, input:focus-visible { outline: 1px solid Highlight; } }' : "",
        'button:focus-visible { outline: none; }',
      ].join("\n"),
    });
    expect((await lintUiStyles(root)).violations).toHaveLength(platformFocus === "matching" ? 1 : 2);
  });
  it("accepts one style entry, token-owned colors, runtime dimensions, and same-file variants", async () => {
    const root = await createFixture({
      "src/web/src/main.tsx": 'import "./styles/index.css";',
      "src/web/src/styles/index.css": '@import "./tokens.css"; @import "./shell.css";',
      "src/web/src/styles/tokens.css": ":root { --ink: #1b1d1f; }",
      "src/web/src/styles/shell.css": [
        ".shell { color: var(--ink); width: var(--left-sidebar-width); }",
        "@media (max-width: 80rem) { .shell { width: var(--right-rail-width); } }",
      ].join("\n"),
    });

    expect((await lintUiStyles(root)).violations).toEqual([]);
  });

  it("reports retired entries, non-token colors, undefined properties, and cross-file selector owners", async () => {
    const root = await createFixture({
      "src/web/src/main.tsx": 'import "./styles.css";',
      "src/web/src/styles.css": ".legacy { color: #fff; }",
      "src/web/src/styles/index.css": '@import "./tokens.css"; @import "./one.css"; @import "./two.css";',
      "src/web/src/styles/tokens.css": ":root { --ink: #1b1d1f; }",
      "src/web/src/styles/one.css": ".shared { color: var(--missing); }",
      "src/web/src/styles/two.css": ".shared { background: rgb(1 2 3); }",
    });

    const violations = (await lintUiStyles(root)).violations.join("\n");
    expect(violations).toContain("retired monolithic style entry");
    expect(violations).toContain("imports retired");
    expect(violations).toContain("expected exactly one source import, found 0");
    expect(violations).toContain("uses undefined custom property --missing");
    expect(violations).toContain("contains product color literal rgb(");
    expect(violations).toContain('selector ".shared" has multiple style owners');
  });

  it("permits the scoped Office and terminal runtime palettes only", async () => {
    const root = await createFixture({
      "src/web/src/main.tsx": 'import "./styles/index.css";',
      "src/web/src/styles/index.css": '@import "./tokens.css";',
      "src/web/src/styles/tokens.css": ":root { --ink: #1b1d1f; }",
      "src/web/src/office/PixiOfficeRenderer.tsx": 'export const background = "#faf9f7";',
      "src/web/src/panels/workbench/TerminalDock.tsx": 'export const foreground = "rgb(32 33 36)";',
      "src/web/src/panels/Other.tsx": 'export const foreground = "#ffffff";',
    });

    const violations = (await lintUiStyles(root)).violations;
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("src/web/src/panels/Other.tsx");
  });

  it("rejects missing imports and styles that are orphaned from the single entry graph", async () => {
    const root = await createFixture({
      "src/web/src/main.tsx": 'import "./styles/index.css";',
      "src/web/src/styles/index.css": '@import "./tokens.css"; @import "./missing.css";',
      "src/web/src/styles/tokens.css": ":root { --ink: #1b1d1f; }",
      "src/web/src/styles/orphan.css": ".orphan { color: var(--ink); }",
    });

    const violations = (await lintUiStyles(root)).violations.join("\n");
    expect(violations).toContain("imported stylesheet is missing");
    expect(violations).toContain("orphan.css: not reachable from the single style entry");
  });

  it("rejects focus outline suppression while allowing an explicit non-focus cleanup", async () => {
    const root = await createFixture({
      "src/web/src/main.tsx": 'import "./styles/index.css";',
      "src/web/src/styles/index.css": '@import "./tokens.css"; @import "./controls.css";',
      "src/web/src/styles/tokens.css": ":root { --ink: #1b1d1f; }",
      "src/web/src/styles/controls.css": [
        ".unsafe input { outline: none; color: var(--ink); }",
        ".hitbox:not(:focus-visible):not(:hover) { outline: 0; }",
      ].join("\n"),
    });

    const violations = (await lintUiStyles(root)).violations;
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("suppresses focus outline");
  });
});

async function createFixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "aho-ui-style-lint-"));
  roots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(root, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
  return root;
}
