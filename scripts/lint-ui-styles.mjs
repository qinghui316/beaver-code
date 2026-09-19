import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

const STYLE_ENTRY = "src/web/src/styles/index.css";
const TOKEN_OWNER = "src/web/src/styles/tokens.css";
const RETIRED_ENTRY = "src/web/src/styles.css";
const RUNTIME_CUSTOM_PROPERTIES = new Set([
  "--left-sidebar-width",
  "--right-rail-width",
]);
const COLOR_LITERAL_ALLOWLIST = new Set([
  "src/web/src/office/PixiOfficeRenderer.tsx",
  "src/web/src/panels/workbench/TerminalDock.tsx",
]);
const COLOR_LITERAL_PATTERN = /#[\da-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\s*\([^)]*\)/gi;
const SOURCE_EXTENSION_PATTERN = /\.(?:css|js|jsx|ts|tsx)$/;

export async function lintUiStyles(rootDirectory = process.cwd()) {
  const root = resolve(rootDirectory);
  const webSourceRoot = resolve(root, "src/web/src");
  const stylesRoot = resolve(root, "src/web/src/styles");
  const violations = [];

  if (!await isFile(resolve(root, STYLE_ENTRY))) {
    violations.push(`${STYLE_ENTRY}: the single tracked UI style entry is missing`);
  }
  if (await isFile(resolve(root, RETIRED_ENTRY))) {
    violations.push(`${RETIRED_ENTRY}: retired monolithic style entry must be deleted`);
  }

  const sourceFiles = await collectFiles(webSourceRoot, SOURCE_EXTENSION_PATTERN);
  const styleFiles = sourceFiles.filter((file) => file.endsWith(".css") && isWithin(file, stylesRoot));
  const entryImportOwners = [];

  for (const file of sourceFiles.filter((candidate) => !candidate.endsWith(".css"))) {
    const content = await readFile(file, "utf8");
    const relativePath = normalizePath(relative(root, file));
    for (const specifier of collectCssImportSpecifiers(content)) {
      if (!specifier.startsWith(".")) continue;
      const resolvedImport = normalizePath(relative(root, resolve(dirname(file), specifier)));
      if (resolvedImport === RETIRED_ENTRY) {
        violations.push(`${relativePath}: imports retired ${RETIRED_ENTRY}`);
      }
      if (resolvedImport.startsWith("src/web/src/") && resolvedImport.endsWith(".css")) {
        if (resolvedImport !== STYLE_ENTRY) {
          violations.push(`${relativePath}: imports first-party CSS ${resolvedImport}; import only ${STYLE_ENTRY}`);
        } else {
          entryImportOwners.push(relativePath);
        }
      }
    }
  }

  if (entryImportOwners.length !== 1) {
    violations.push(`${STYLE_ENTRY}: expected exactly one source import, found ${entryImportOwners.length}`);
  }

  const reachableStyles = await collectReachableStyles(resolve(root, STYLE_ENTRY), stylesRoot, root, violations);
  for (const file of styleFiles) {
    if (!reachableStyles.has(file)) {
      violations.push(`${normalizePath(relative(root, file))}: not reachable from the single style entry ${STYLE_ENTRY}`);
    }
  }

  const customPropertyDefinitions = new Set();
  const customPropertyUses = [];
  const selectorOwners = new Map();

  for (const file of styleFiles) {
    const content = await readFile(file, "utf8");
    const relativePath = normalizePath(relative(root, file));
    const searchable = stripCssComments(content);

    for (const match of searchable.matchAll(/(^|[;{])\s*(--[\w-]+)\s*:/gm)) {
      customPropertyDefinitions.add(match[2]);
    }
    for (const match of searchable.matchAll(/\bvar\(\s*(--[\w-]+)/g)) {
      customPropertyUses.push({ property: match[1], path: relativePath, index: match.index ?? 0, content });
    }

    if (relativePath !== TOKEN_OWNER) {
      collectColorLiteralViolations(content, relativePath, violations);
    }
    collectOutlineResetViolations(content, relativePath, violations);

    const selectorsInFile = new Set(collectSelectors(content));
    for (const selector of selectorsInFile) {
      const owners = selectorOwners.get(selector) ?? [];
      owners.push(relativePath);
      selectorOwners.set(selector, owners);
    }
  }

  for (const use of customPropertyUses) {
    if (!customPropertyDefinitions.has(use.property) && !RUNTIME_CUSTOM_PROPERTIES.has(use.property)) {
      violations.push(`${use.path}:${lineAt(use.content, use.index)} uses undefined custom property ${use.property}`);
    }
  }

  for (const [selector, owners] of selectorOwners) {
    if (owners.length > 1) {
      violations.push(`selector ${JSON.stringify(selector)} has multiple style owners: ${owners.join(", ")}`);
    }
  }

  for (const file of sourceFiles.filter((candidate) => !candidate.endsWith(".css"))) {
    const relativePath = normalizePath(relative(root, file));
    if (COLOR_LITERAL_ALLOWLIST.has(relativePath)) continue;
    collectColorLiteralViolations(await readFile(file, "utf8"), relativePath, violations);
  }

  return {
    filesChecked: sourceFiles.length,
    styleFilesChecked: styleFiles.length,
    violations,
  };
}

function collectCssImportSpecifiers(content) {
  const specifiers = [];
  const patterns = [
    /\bimport\s*(?:[^"'`;]*?\bfrom\s*)?["']([^"']+\.css)["']/g,
    /\bimport\s*\(\s*["']([^"']+\.css)["']/g,
    /\brequire\s*\(\s*["']([^"']+\.css)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

function collectStylesheetImportSpecifiers(content) {
  return [...content.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+\.css)["']\s*\)?[^;]*;/g)]
    .map((match) => match[1]);
}

async function collectReachableStyles(entry, stylesRoot, root, violations) {
  const reachable = new Set();
  const visiting = new Set();

  const visit = async (file) => {
    if (reachable.has(file)) return;
    if (visiting.has(file)) {
      violations.push(`${normalizePath(relative(root, file))}: stylesheet import cycle detected`);
      return;
    }
    if (!await isFile(file)) {
      violations.push(`${normalizePath(relative(root, file))}: imported stylesheet is missing`);
      return;
    }
    if (!isWithin(file, stylesRoot) && file !== resolve(root, STYLE_ENTRY)) {
      violations.push(`${normalizePath(relative(root, file))}: stylesheet import escapes src/web/src/styles`);
      return;
    }

    visiting.add(file);
    for (const specifier of collectStylesheetImportSpecifiers(await readFile(file, "utf8"))) {
      if (!specifier.startsWith(".")) continue;
      await visit(resolve(dirname(file), specifier));
    }
    visiting.delete(file);
    reachable.add(file);
  };

  await visit(entry);
  return reachable;
}

function collectColorLiteralViolations(content, relativePath, violations) {
  for (const match of content.matchAll(COLOR_LITERAL_PATTERN)) {
    violations.push(`${relativePath}:${lineAt(content, match.index ?? 0)} contains product color literal ${match[0]}; use ${TOKEN_OWNER}`);
  }
}

function collectOutlineResetViolations(content, relativePath, violations) {
  const text = stripCssComments(content);
  visitStyleRules(text, 0, text.length, (selector, body, bodyOffset) => {
    const reset = /\boutline\s*:\s*(?:none|0)(?:\s*!important)?\s*;/i.exec(body);
    if (!reset || selector.includes(":not(:focus-visible)")) return;
    const quietTextSelector = 'textarea:focus,input:not([type]):focus,input:is([type="text"],[type="search"],[type="email"],[type="url"],[type="password"],[type="tel"],[type="number"]):focus';
    const platformFocus = /@media\s*\(forced-colors:\s*active\)\s*\{\s*([^{}]+)\{\s*outline:\s*1px solid Highlight;/i.exec(text);
    const hasPlatformFocus = platformFocus?.[1].replace(/\s+/g, "") === quietTextSelector;
    if (relativePath === "src/web/src/styles/base.css"
      && selector.replace(/\s+/g, "") === quietTextSelector && hasPlatformFocus) return;
    violations.push(`${relativePath}:${lineAt(content, bodyOffset + reset.index)} suppresses focus outline; use the shared :focus-visible contract`);
  });
}

function visitStyleRules(text, start, end, onRule) {
  let cursor = start;
  while (cursor < end) {
    cursor = skipWhitespaceAndSemicolons(text, cursor, end);
    if (cursor >= end) return;
    const openBrace = findNextUnquoted(text, "{", cursor, end);
    if (openBrace < 0) return;
    const closeBrace = findMatchingBrace(text, openBrace, end);
    if (closeBrace < 0) return;
    const header = text.slice(cursor, openBrace).trim();
    if (header.startsWith("@")) {
      visitStyleRules(text, openBrace + 1, closeBrace, onRule);
    } else if (header) {
      onRule(header, text.slice(openBrace + 1, closeBrace), openBrace + 1);
    }
    cursor = closeBrace + 1;
  }
}

export function collectSelectors(content) {
  const text = stripCssComments(content);
  const selectors = [];
  visitCssBlocks(text, 0, text.length, false, selectors);
  return selectors;
}

function visitCssBlocks(text, start, end, insideKeyframes, selectors) {
  let cursor = start;
  while (cursor < end) {
    cursor = skipWhitespaceAndSemicolons(text, cursor, end);
    if (cursor >= end) return;
    const openBrace = findNextUnquoted(text, "{", cursor, end);
    if (openBrace < 0) return;
    const closeBrace = findMatchingBrace(text, openBrace, end);
    if (closeBrace < 0) return;

    const header = text.slice(cursor, openBrace).trim();
    if (header.startsWith("@")) {
      const atRule = header.match(/^@([\w-]+)/)?.[1]?.toLowerCase() ?? "";
      const isKeyframes = /^(?:-\w+-)?keyframes$/.test(atRule);
      if (!isKeyframes && atRule !== "font-face" && atRule !== "page" && atRule !== "property") {
        visitCssBlocks(text, openBrace + 1, closeBrace, insideKeyframes, selectors);
      }
    } else if (!insideKeyframes && header) {
      for (const selector of splitSelectorList(header)) {
        const normalized = normalizeSelector(selector);
        if (normalized) selectors.push(normalized);
      }
    }
    cursor = closeBrace + 1;
  }
}

function splitSelectorList(value) {
  const result = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "(" || character === "[") depth += 1;
    else if (character === ")" || character === "]") depth = Math.max(0, depth - 1);
    else if (character === "," && depth === 0) {
      result.push(value.slice(start, index));
      start = index + 1;
    }
  }
  result.push(value.slice(start));
  return result;
}

function normalizeSelector(value) {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*([>+~])\s*/g, "$1");
}

function stripCssComments(content) {
  return content.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

function skipWhitespaceAndSemicolons(text, start, end) {
  let cursor = start;
  while (cursor < end && /[\s;]/.test(text[cursor])) cursor += 1;
  return cursor;
}

function findNextUnquoted(text, target, start, end) {
  let quote = "";
  for (let index = start; index < end; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === target) {
      return index;
    }
  }
  return -1;
}

function findMatchingBrace(text, openBrace, end) {
  let depth = 1;
  let quote = "";
  for (let index = openBrace + 1; index < end; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index;
  }
  return -1;
}

function lineAt(content, index) {
  return content.slice(0, index).split("\n").length;
}

async function collectFiles(directory, extensionPattern) {
  if (!await isDirectory(directory)) return [];
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...await collectFiles(path, extensionPattern));
    else if (entry.isFile() && extensionPattern.test(entry.name)) result.push(path);
  }
  return result;
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch (cause) {
    if (cause?.code === "ENOENT") return false;
    throw cause;
  }
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch (cause) {
    if (cause?.code === "ENOENT") return false;
    throw cause;
  }
}

function isWithin(path, directory) {
  const normalizedPath = normalizePath(resolve(path));
  const normalizedDirectory = `${normalizePath(resolve(directory))}/`;
  return normalizedPath.startsWith(normalizedDirectory);
}

function normalizePath(value) {
  return value.split(sep).join("/");
}

const isCli = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isCli) {
  const result = await lintUiStyles(process.cwd());
  if (result.violations.length > 0) {
    process.stderr.write(`UI style lint failed:\n${result.violations.map((item) => `- ${item}`).join("\n")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`UI style lint passed (${result.styleFilesChecked} style files, ${result.filesChecked} web source files).\n`);
  }
}
