#!/usr/bin/env node
/*
 * Builds the repository directory page (index.html at the repo root).
 *
 * It reads every git-tracked file, extracts titles, summaries, outlines and
 * relationships, and injects them as JSON into tools/index.template.html.
 *
 * Usage:  node tools/build-index.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const REPO = "abhinav998/adobeCampaignClassicJs";
const BRANCH = "main";
const SITE = "https://opensource.adobe.com/acc-js-sdk/";
const TEXT_CAP = 6000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const lines = (s) => s.split(/\r?\n/);
// Number of lines as editors and `wc -l` count them (a final newline does not start a new line)
const lineCount = (s) => s.split(/\r?\n/).length - (/\r?\n$/.test(s) ? 1 : 0);

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", rarr: "→", larr: "←", harr: "↔", mdash: "—", ndash: "–", hellip: "…", copy: "©" };
function decode(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/&(amp|lt|gt|quot|nbsp)(?![a-z;])/gi, (m, n) => ENTITIES[n.toLowerCase()]); // legacy entities without ";"
}
const stripLiquid = (s) => s.replace(/\{%[\s\S]*?%\}/g, " ").replace(/\{\{[\s\S]*?\}\}/g, " ");
const tidy = (s) => s.replace(/\s+/g, " ").replace(/\s+([.,;:!?)])/g, "$1").replace(/\(\s+/g, "(").trim();
// Strip tags, decode entities, then strip any tags that were written escaped in the source (e.g. &lt;b&gt;)
const stripTags = (s) => tidy(decode(stripLiquid(s).replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ")).replace(/<\/?[a-z][^>]*>/gi, ""));
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : s);

function githubUrl(p, line) {
  const enc = p.split("/").map(encodeURIComponent).join("/");
  let url = `https://github.com/${REPO}/blob/${BRANCH}/${enc}`;
  if (line) url += (/\.md$/i.test(p) ? "?plain=1" : "") + `#L${line}`;
  return url;
}

function frontMatter(src) {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: src, offset: 0 };
  const data = {};
  for (const l of lines(m[1])) {
    const kv = l.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (kv) data[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return { data, body: src.slice(m[0].length), offset: lines(m[0]).length - 1 };
}

// Simple parser for docs/_data/navigation.yml (two levels)
function parseNav() {
  const groups = [];
  let top = null;
  let cur = null;
  for (const l of lines(read("docs/_data/navigation.yml"))) {
    let m;
    if ((m = l.match(/^- name:\s*(.*)$/))) {
      cur = top = { name: decode(m[1].trim()), link: null, children: [] };
      groups.push(top);
    } else if ((m = l.match(/^\s+- name:\s*(.*)$/))) {
      cur = { name: decode(m[1].trim()), link: null };
      top.children.push(cur);
    } else if ((m = l.match(/^\s+link:\s*(.*)$/)) && cur) {
      let link = m[1].trim();
      if (!/\.html$/.test(link)) link += ".html";
      cur.link = link;
    }
  }
  return groups.filter((g) => g.name !== "--");
}

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

function htmlDoc(p) {
  const src = read(p);
  const { data, body, offset } = frontMatter(src);
  const headings = [];
  lines(body).forEach((l, i) => {
    const re = /<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi;
    let m;
    while ((m = re.exec(l))) {
      const t = stripTags(m[2]);
      if (t) headings.push({ t, l: i + 1 + offset, lvl: +m[1] });
    }
  });
  const clean = body.replace(/<!--[\s\S]*?-->/g, "");
  const firstP = [...clean.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/gi)].map((m) => stripTags(m[1])).find((t) => t.length > 20);
  const text = stripTags(clean.replace(/<pre[\s\S]*?<\/pre>/gi, (m) => " " + m + " "));
  return {
    title: decode(data.title || path.basename(p, ".html")),
    summary: clip(data.excerpt || firstP || text || "This page has no content yet.", 260),
    headings,
    text: clip(text, TEXT_CAP),
    data,
  };
}

function markdownDoc(p) {
  const src = read(p);
  const { data, body, offset } = frontMatter(src);
  const headings = [];
  let inFence = false;
  const paras = [];
  let buf = [];
  lines(body).forEach((l, i) => {
    if (/^\s*```/.test(l)) { inFence = !inFence; return; }
    if (inFence) return;
    const h = l.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      headings.push({ t: h[2].replace(/[`*_]/g, "").trim(), l: i + 1 + offset, lvl: h[1].length });
      if (buf.length) { paras.push(buf.join(" ")); buf = []; }
      return;
    }
    if (!l.trim()) { if (buf.length) { paras.push(buf.join(" ")); buf = []; } return; }
    if (/^\s*(>|\||---|<)/.test(l) && !buf.length) return;
    const li = l.match(/^\s*(?:[-*+]|\d+\.)\s+(?:\[[ x]\]\s+)?(.*)$/i);
    if (li) { buf.push((buf.length ? "; " : "") + li[1].trim()); return; }
    buf.push(l.trim());
  });
  if (buf.length) paras.push(buf.join(" "));
  for (let i = 0; i < paras.length; i++) paras[i] = paras[i].replace(/\s+;/g, ";");
  const md = (s) => s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[`*_]/g, "");
  const title = headings.find((h) => h.lvl === 1)?.t || data.name || path.basename(p);
  const firstPara = paras.find((x) => x.length > 30) || paras[0] || "";
  return {
    title,
    summary: clip(tidy(md(data.description || firstPara)), 260),
    headings,
    text: clip(md(body.replace(/\s+/g, " ")), TEXT_CAP),
    data,
  };
}

function jsOutline(src, { methods = true } = {}) {
  const out = [];
  const skip = new Set(["if", "for", "while", "switch", "catch", "function", "return", "else"]);
  lines(src).forEach((l, i) => {
    let m;
    if ((m = l.match(/^\s*class\s+([A-Za-z_$][\w$]*)/))) out.push({ t: `class ${m[1]}`, l: i + 1, lvl: 1 });
    else if ((m = l.match(/^\s{0,4}(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/))) out.push({ t: `${m[1]}()`, l: i + 1, lvl: 2 });
    else if (methods && (m = l.match(/^\s{2,6}(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/)) && !skip.has(m[1])) out.push({ t: `${m[1]}()`, l: i + 1, lvl: 3 });
  });
  return out.slice(0, 250);
}

function jsExports(src) {
  return [...new Set([...src.matchAll(/exports\.([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]))];
}

function jsComments(src) {
  return [...src.matchAll(/\/\*\*([\s\S]*?)\*\//g)]
    .map((m) => m[1].replace(/^\s*\*\s?/gm, " ").replace(/@\w+\s*(\{[^}]*\})?/g, " "))
    .filter((t) => !/Copyright|Licensed|Apache License/i.test(t))
    .join(" ").replace(/\s+/g, " ").trim();
}

function testOutline(src) {
  const out = [];
  const names = [];
  let count = 0;
  let each = 0;
  lines(src).forEach((l, i) => {
    const d = l.match(/^(\s*)describe(?:\.\w+)?\s*\(\s*(["'`])(.*?)\2/);
    if (d) out.push({ t: d[3], l: i + 1, lvl: Math.min(3, 1 + Math.floor(d[1].length / 4)) });
    const t = l.match(/^\s*(?:it|test)(?:\.(?:only|skip|concurrent))?\s*\(\s*(["'`])(.*?)\1/);
    if (t) { count++; names.push(t[2]); }
    else if (/^\s*(?:it|test)\.each\s*\(/.test(l)) { count++; each++; }
  });
  return { headings: out.slice(0, 200), count, each, names };
}

function sampleInfo(src) {
  const headings = [];
  const labels = new Set();
  lines(src).forEach((l, i) => {
    const t = l.match(/^\s*title:\s*(["'`])(.*)\1\s*,?\s*$/);
    if (t) headings.push({ t: t[2], l: i + 1, lvl: 2 });
    const lb = l.match(/^\s*labels:\s*\[(.*)\]/);
    if (lb) lb[1].split(",").forEach((x) => { x = x.trim().replace(/^["']|["']$/g, ""); if (x) labels.add(x); });
  });
  // The description is the last block comment before the code starts (some files start with a copied, unrelated banner)
  const codeStart = src.search(/\(\s*async\s*\(|utils\.logon\(/);
  const head = codeStart === -1 ? src : src.slice(0, codeStart);
  const comment = [...head.matchAll(/\/\*([\s\S]*?)\*\//g)].map((m) => m[1]).filter((c) => !/Copyright|Licensed/i.test(c)).pop();
  const banner = src.match(/This sample illustrates[^\n`]*/);
  const clean = (c) => lines(c).map((l) => l.replace(/^\s*\*+\s?/, "").trim()).filter((l) => l && !/^[-*]+$/.test(l))
    .map((l, i) => (/^-\s+/.test(l) ? (i ? "; " : "") + l.replace(/^-\s+/, "") : (i ? " " : "") + l)).join("").replace(/\s+;/g, ";").trim();
  const summary = comment ? clean(comment) : banner ? banner[0].trim() : "";
  return { headings, labels: [...labels], summary };
}

// ---------------------------------------------------------------------------
// Hand-written descriptions for files whose content does not describe itself
// ---------------------------------------------------------------------------

const SRC_DESC = {
  "src/index.js": "SDK entry point. Exports the sdk object: init(), getSDKVersion(), ip(), escapeXtk(), escapeForLike(), expandXPath(), unexpandXPath() and xtkConstText(), plus the XtkCaster, DomUtil, Credentials, ConnectionParameters, HttpError and TestUtil classes.",
  "src/client.js": "Heart of the SDK (2400+ lines). The Client class, ConnectionParameters and Credentials; the NLWS proxy that turns client.NLWS.xtkQueryDef.create() into SOAP calls; logon/logoff, session state, observers, caches and API dispatch via _callMethod().",
  "src/soap.js": "SoapMethodCall: builds SOAP request envelopes, sends them through the transport layer and parses responses and SOAP faults back into JavaScript values.",
  "src/domUtil.js": "DOM and XML helpers: parsing and serializing XML, traversal, XPath helpers, and conversions between XML and JSON (SimpleJson and BadgerFish). Uses JSDOM under Node.js.",
  "src/xtkCaster.js": "XtkCaster: converts values between Campaign (XTK) types and JavaScript types — strings, numbers, booleans, dates, timespans, memos and more.",
  "src/transport.js": "Isomorphic HTTP transport: axios under Node.js, fetch in the browser. Defines HttpError.",
  "src/application.js": "The Application object and the schema object model (XtkSchema, XtkSchemaNode, XtkSchemaKey, XtkJoin, XtkEnumeration), plus SchemaCache and CurrentLogin.",
  "src/campaign.js": "CampaignException and its SDK-0000xx error codes, plus constants for Campaign enumerations (delivery states and message types, workflow states, task statuses, operations, offers and more).",
  "src/cache.js": "Generic Cache base class and SafeStorage, a wrapper around localStorage-like stores used to persist caches.",
  "src/methodCache.js": "Caches SOAP method definitions (from schemas) so method signatures are not fetched on every call.",
  "src/optionCache.js": "Caches xtk:option values read through getOption().",
  "src/xtkEntityCache.js": "In-memory cache of XTK entities fetched from the server, such as schemas (keyed like \"xtk:schema|nms:recipient\").",
  "src/cacheRefresher.js": "Refreshes a cache at a regular interval by asking the server for recently modified entities (xtk:session#GetModifiedEntities, Campaign 8.4 and above). Started with client.startRefreshCaches().",
  "src/entityAccessor.js": "EntityAccessor: reads attributes and child elements from entities regardless of their representation (XML DOM, SimpleJson or BadgerFish).",
  "src/xtkJob.js": "XtkJobInterface: runs long-running XTK jobs (execute or submit), then reads their status, progress, logs and result, and can pause or cancel them.",
  "src/crypto.js": "Cipher (Node.js only): encrypts and decrypts Campaign passwords with the instance key from the XtkSecretKey or XtkKey option (AES-256-CBC).",
  "src/util.js": "Utilities: Util (browser detection, redacting sensitive text with trim(), schema id ↔ namespace mapping, UUIDs, promise helpers) and the ArrayMap collection.",
  "src/testUtil.js": "TestUtil: helpers for writing tests against the SDK. newSchema() builds a schema object from XML.",
  "src/web/bundler.js": "Minimal module loader (define/require) used by compile.js to package the SDK into a single browser bundle.",
};

const META_DESC = {
  ".eslintrc.js": "ESLint configuration for the source code (npm run lint).",
  ".gitignore": "Files and folders git ignores (node_modules, coverage, build output…).",
  "babel.config.js": "Babel configuration Jest uses (through babel-jest) to transpile JavaScript for the current Node.js version, including ES-module dependencies of jsdom.",
  "compile.js": "Builds the browser bundle dist/bundle.js by concatenating the src/ modules, in dependency order, around the web bundler.",
  "jsdoc.json": "JSDoc configuration for generating the API reference (npm run jsdoc).",
  "package-lock.json": "Exact, locked versions of every npm dependency.",
  ".github/ISSUE_TEMPLATE.md": "Template for new GitHub issues: expected vs actual behaviour, steps to reproduce, platform and version.",
  "COPYRIGHT": "Copyright notice for the project.",
  "LICENSE": "Apache License 2.0 — the terms under which the SDK is distributed.",
  "openspec/config.yaml": "Configuration for OpenSpec, the spec-driven change workflow used with AI coding assistants.",
  "test/jest.config.js": "Jest configuration: coverage of src/ with 100% thresholds for branches, lines and statements, the jest-junit reporter, and Babel transforms.",
  "test/mock.js": "Canned Campaign SOAP responses (logon, schemas, options, queries…) that the unit tests use in place of a real server.",
  "samples/utils.js": "Helpers shared by the samples: reads the ACC_URL, ACC_USER and ACC_PASSWORD environment variables, logs on, and runs and prints each sample.",
  "docs/_config.yml": "Jekyll configuration of the documentation site (title, base URL, plugins, collections).",
  "docs/Gemfile": "Ruby gems needed to build the documentation site locally with Jekyll.",
  "docs/Gemfile.lock": "Locked Ruby gem versions for the documentation site.",
  "docs/.gitignore": "Files git ignores inside docs/: Jekyll build output and caches.",
  "docs/_data/navigation.yml": "The documentation site's left-hand menu: every section and page, in order.",
  "docs/_includes/navigation.html": "Jekyll include that renders the navigation menu from navigation.yml.",
  "docs/_layouts/default.html": "Base page layout of the documentation site (header, menu, footer).",
  "docs/_layouts/home.html": "Layout of the documentation home page.",
  "docs/_layouts/page.html": "Layout used by regular documentation pages.",
  "docs/_layouts/post.html": "Layout used by blog posts.",
  "docs/assets/css/styles.css": "Stylesheet of the documentation site.",
  "docs/assets/images/adobe-campaign-256.png": "Adobe Campaign logo used on the documentation site.",
  "docs/assets/images/architecture.png": "SDK architecture diagram shown on the Architecture page.",
  "docs/assets/images/ref.svg": "Icon shown before cross-reference notes (p.ref) on the documentation site.",
  "docs/favicon.png": "Favicon of the documentation site.",
  ".github/PULL_REQUEST_TEMPLATE.md": "Template for new pull requests: description, related issue, motivation, testing, type of change and a checklist.",
  "CLAUDE.md": "Tells Claude Code to read AGENTS.md (the file only contains @AGENTS.md).",
  "src/CLAUDE.md": "Tells Claude Code to read src/AGENTS.md (the file only contains @AGENTS.md).",
  "test/CLAUDE.md": "Tells Claude Code to read test/AGENTS.md (the file only contains @AGENTS.md).",
  "docs/blog.html": "Lists the blog posts with their author, date and excerpt.",
  "docs/404.html": "\"Page not found\" page of the documentation site.",
  "index.html": "This page: an interactive directory of everything in the repository.",
  "tools/build-index.js": "Generator for this page. Re-run `node tools/build-index.js` after changing the repository.",
  "tools/index.template.html": "HTML, CSS and JavaScript template that build-index.js fills with the repository data.",
};

// Manual relationships between documentation pages, source, tests and samples
const WORKFLOWS = {
  ".github/workflows/static.yml": {
    summary: "GitHub Actions workflow that publishes the repository to GitHub Pages, so this directory page is live at https://abhinav998.github.io/adobeCampaignClassicJs/.",
    facts: [
      ["Triggers", "Pushes to main, and manual runs"],
      ["Publishes", "The whole repository as static files (no Jekyll build); index.html is the home page"],
      ["Site", "https://abhinav998.github.io/adobeCampaignClassicJs/"],
    ],
  },
  ".github/workflows/codeql-analysis.yml": {
    summary: "GitHub Actions workflow that runs CodeQL security analysis on the JavaScript code.",
    facts: [
      ["Triggers", "Pushes and pull requests to master, a weekly schedule (Thursdays 13:34 UTC), and manual runs"],
      ["In this repository", "The default branch is main, so the push and pull-request triggers never fire. The weekly schedule and manual runs do run, on main."],
    ],
  },
  ".github/workflows/npm-publish.yml": {
    summary: "GitHub Actions workflow that publishes the package to npm, and tags the release, when a commit whose message starts with “Release x.y.z” is pushed to master.",
    facts: [
      ["Triggers", "Pushes to master"],
      ["In this repository", "The default branch is main, so this workflow never runs."],
    ],
  },
};

const SAMPLE_DESC = {
  // The file's own header comment ("server version") does not describe it
  "samples/020 - encryption.js": "Encrypts and hashes a password with the xtk:session APIs (Encrypt, EncryptPassword, EncryptServerPassword, HashPassword, ReEncryptPassword).",
};

const RELATED = {
  "docs/connecting.html": ["src/client.js", "test/credentials.test.js", "test/imBearerToken.test.js", "samples/000 - basics - logon.js"],
  "docs/connectionParameters.html": ["src/client.js", "test/credentials.test.js"],
  "docs/concepts.html": ["src/client.js", "docs/architecture.html"],
  "docs/soapAPIs.html": ["src/soap.js", "src/client.js", "test/soap.test.js"],
  "docs/dataTypes.html": ["src/xtkCaster.js", "docs/xtkCaster.html"],
  "docs/xtkCaster.html": ["src/xtkCaster.js", "test/xtkCaster.test.js"],
  "docs/escaping.html": ["src/index.js", "test/escape.test.js"],
  "docs/errors.html": ["src/campaign.js", "test/soap.test.js"],
  "docs/architecture.html": ["src/index.js", "compile.js", "src/web/bundler.js", "docs/assets/images/architecture.png"],
  "docs/xtkSession.html": ["src/client.js", "samples/000 - basics - logon.js"],
  "docs/xtkQueryDef.html": ["src/client.js", "samples/001 - basics - queries.js"],
  "docs/xtkWrite.html": ["samples/004 - basics - writer.js"],
  "docs/xtkOption.html": ["src/optionCache.js", "src/client.js"],
  "docs/xtkPackage.html": ["test/client.hasPackage.test.js", "samples/011 - basics - packages.js"],
  "docs/xtkPersist.html": ["test/xtkPersist.test.js", "samples/005 - basics - persist.js"],
  "docs/xtkSchema.html": ["src/application.js", "samples/002 - basics - schemas.js"],
  "docs/application.html": ["src/application.js", "test/application.test.js"],
  "docs/xtkWorkflow.html": ["samples/030 - basics - workflows.js"],
  "docs/healthCheck.html": ["samples/009 - basics - health.js"],
  "docs/messageCenter.html": ["samples/600 - message center - push event.js"],
  "docs/domHelper.html": ["src/domUtil.js", "test/domUtil.test.js"],
  "docs/xml2json.html": ["src/domUtil.js", "docs/simpleJson.html", "docs/badgerFish.html"],
  "docs/simpleJson.html": ["src/domUtil.js"],
  "docs/badgerFish.html": ["src/domUtil.js"],
  "docs/caches.html": ["src/cache.js", "src/methodCache.js", "src/optionCache.js", "src/xtkEntityCache.js", "src/cacheRefresher.js", "test/caches.test.js"],
  "docs/methodLevelRepresentation.html": ["src/client.js", "src/soap.js"],
  "docs/xtkInterface.html": ["src/client.js", "test/xtkProxy.test.js"],
  "docs/xtkJob.html": ["src/xtkJob.js", "test/xtkJob.test.js"],
  "docs/timeouts.html": ["src/transport.js", "src/client.js"],
  "docs/abortRequest.html": ["src/transport.js", "src/client.js"],
  "docs/httpHeaders.html": ["src/client.js", "src/transport.js"],
  "docs/transport.html": ["src/transport.js", "test/transport.test.js"],
  "docs/observability.html": ["src/client.js", "test/observability.test.js"],
  "docs/dynamicInvoke.html": ["src/client.js"],
  "docs/entityAccessor.html": ["src/entityAccessor.js", "test/entityAccessor.test.js"],
  "docs/passwords.html": ["src/crypto.js", "test/crypto.test.js", "samples/020 - encryption.js"],
  "docs/samples.html": ["samples/utils.js", "samples/000 - basics - logon.js"],
  "docs/buildAndRun.html": ["package.json", "compile.js", "test/jest.config.js"],
  "docs/installation.html": ["package.json"],
  "docs/release.html": ["package.json", ".github/workflows/npm-publish.yml"],
  "docs/writeDoc.html": ["docs/_config.yml", "docs/_data/navigation.yml"],
  "docs/contribute.html": [".github/CONTRIBUTING.md", "CODE_OF_CONDUCT.md"],
  "docs/checkList.html": [".github/PULL_REQUEST_TEMPLATE.md"],
  "docs/license.html": ["LICENSE", "COPYRIGHT"],
  "docs/changeLog.html": ["MIGRATION.md", "package.json"],
  "src/cache.js": ["test/caches.test.js"],
  "src/methodCache.js": ["test/caches.test.js"],
  "src/optionCache.js": ["test/caches.test.js"],
  "src/xtkEntityCache.js": ["test/caches.test.js"],
  "src/client.js": ["test/xtkProxy.test.js", "test/observability.test.js", "test/credentials.test.js", "test/imBearerToken.test.js", "test/xtkPersist.test.js"],
  "src/web/bundler.js": ["test/web.bundler.test.js", "compile.js"],
  "src/index.js": ["test/escape.test.js"],
  "src/campaign.js": ["test/soap.test.js"],
  "README.md": ["docs/index.html", "MIGRATION.md"],
  "AGENTS.md": ["CLAUDE.md", "src/AGENTS.md", "test/AGENTS.md", "ai-docs/coding-rules.md", "ai-docs/tech-stack.md"],
  "test/mock.js": ["test/client.test.js"],
};

// ---------------------------------------------------------------------------
// Groups (sections shown in the sidebar)
// ---------------------------------------------------------------------------

const CATS = {
  docs: { label: "Docs", hint: "Documentation site: pages, blog posts and the files that build the site" },
  src: { label: "Source", hint: "SDK source modules in src/" },
  tests: { label: "Tests", hint: "Jest unit tests in test/" },
  samples: { label: "Samples", hint: "Runnable examples in samples/" },
  meta: { label: "Project", hint: "README, guides, AI docs, build and config" },
};

const groups = [];
const groupById = {};
function group(id, label, cat, desc) {
  const g = { id, label, cat, desc, items: [] };
  groups.push(g);
  groupById[id] = g;
  return g;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const files = execSync("git ls-files", { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
// Include the generated files themselves, even before they are committed
for (const f of ["index.html", "tools/build-index.js", "tools/index.template.html"]) if (!files.includes(f)) files.push(f);
files.sort();

const items = {};
function add(p, gid, extra) {
  const stat = p !== "index.html" && fs.existsSync(path.join(ROOT, p)) ? fs.statSync(path.join(ROOT, p)) : { size: null };
  const it = {
    id: p,
    path: p,
    group: gid,
    cat: groupById[gid].cat,
    title: p,
    summary: "",
    headings: [],
    tags: [],
    facts: [],
    related: [],
    text: "",
    github: githubUrl(p),
    site: null,
    size: stat.size,
    ...extra,
  };
  items[p] = it;
  groupById[gid].items.push(p);
  return it;
}

// 1) Documentation site pages, grouped like the site menu
const nav = parseNav();
const navOrder = {};
const NAV_GROUP_IDS = {};
nav.forEach((n) => {
  if (n.children.length) {
    const gid = "nav-" + n.name.toLowerCase().replace(/[^a-z]+/g, "-").replace(/-+$/, "");
    NAV_GROUP_IDS[n.name] = gid;
  }
});
group("getting-started", "Getting started", "docs", "Home, quick start, installation, samples, best practices and troubleshooting.");
group("blog", "Blog", "docs", "Articles from the SDK blog.");
for (const n of nav) if (n.children.length) group(NAV_GROUP_IDS[n.name], n.name, "docs", {
  "Documentation": "Core concepts: connecting, SOAP APIs, data types, escaping, errors and architecture.",
  "Campaign API": "The Campaign APIs exposed by the SDK: sessions, queries, writes, schemas, workflows and more.",
  "Advanced Topics": "XML/JSON formats, caches, interfaces, jobs, timeouts, transport, observability…",
  "Contributing": "How to build, document, check and release the SDK.",
}[n.name] || "");
group("license-changes", "License & change log", "docs", "License terms and the history of SDK releases.");
group("docs-other", "Other doc pages", "docs", "Pages that exist on the docs site but are not in its menu.");
group("docs-site", "Docs site internals", "docs", "Jekyll configuration, layouts, styles and images behind the documentation site.");
group("src", "Source code", "src", "The SDK modules in src/. Every file works in Node.js and in the browser.");
group("tests", "Unit tests", "tests", "Jest test suites in test/ (100% coverage is enforced).");
group("samples", "Samples", "samples", "Runnable examples. Each file runs a series of titled samples against a Campaign instance.");
group("project", "Project & community", "meta", "README, migration guide, license, code of conduct and GitHub templates.");
group("ai", "AI & agent docs", "meta", "Instructions for AI coding assistants: AGENTS.md / CLAUDE.md, coding rules, OpenSpec skills, prompts and commands.");
group("build", "Build & config", "meta", "npm package, build script, lint/test/doc configuration and CI workflows.");
group("other", "Other files", "meta", "Everything else in the repository.");

nav.forEach((n, i) => {
  const list = n.children.length ? n.children : [n];
  if (n.children.length && n.link) navOrder["docs/" + n.link] = { gid: NAV_GROUP_IDS[n.name], label: n.name, order: i * 100 - 1 };
  list.forEach((c, j) => {
    if (!c.link) return;
    navOrder["docs/" + c.link] = { gid: n.children.length ? NAV_GROUP_IDS[n.name] : (/license|change/i.test(n.name) ? "license-changes" : "getting-started"), label: c.name, order: i * 100 + j };
  });
});

const docPages = files.filter((f) => /^docs\/[^/]+\.html$/.test(f) && f !== "docs/404.html");
docPages.sort((a, b) => (navOrder[a]?.order ?? 1e6) - (navOrder[b]?.order ?? 1e6) || a.localeCompare(b));
for (const p of docPages) {
  const d = htmlDoc(p);
  const n = navOrder[p];
  const name = path.basename(p);
  const gid = n ? n.gid : (name === "blog.html" ? "blog" : "docs-other");
  add(p, gid, {
    title: n ? n.label : d.title,
    subtitle: n && n.label !== d.title ? d.title : null,
    summary: META_DESC[p] || d.summary,
    headings: d.headings,
    text: d.text,
    site: SITE + (name === "index.html" ? "" : name),
    kind: "Doc page",
    facts: [["Menu section", n ? (nav.find((x) => x.children.some((c) => "docs/" + c.link === p))?.name || "Top level") : "Not in menu"]].concat(d.headings.length ? [["Sections", String(d.headings.length)]] : []),
  });
}

for (const p of files.filter((f) => f.startsWith("docs/_posts/"))) {
  const d = htmlDoc(p);
  const date = path.basename(p).slice(0, 10);
  const tags = (d.data.tags || "").split(/\s+/).filter(Boolean);
  const cats = (d.data.categories || d.data.category || "").split(/\s+/).filter(Boolean).map((c) => c.toLowerCase());
  const slug = path.basename(p, path.extname(p)).slice(11);
  const postUrl = SITE + [...cats, ...date.split("-"), slug + ".html"].join("/");
  add(p, "blog", {
    title: d.title,
    summary: d.summary,
    headings: d.headings,
    text: d.text,
    tags,
    site: postUrl,
    kind: "Blog post",
    date,
    facts: [["Published", date], ["Author", d.data.author || "—"]].concat(d.data.categories ? [["Category", d.data.categories]] : []),
  });
}

// 2) Source
for (const p of files.filter((f) => /^src\/.*\.js$/.test(f))) {
  const src = read(p);
  let exp = jsExports(src);
  const def = src.match(/module\.exports\s*=\s*([A-Za-z_$][\w$]*)\s*;/);
  if (!exp.length && def) {
    const cls = src.match(/class\s+\w+\s*\{([\s\S]*?)\n  \}/);
    const methods = cls ? [...cls[1].matchAll(/^\s{4}(?:async\s+)?([a-z][\w$]*)\s*\(/gm)].map((m) => m[1] + "()").filter((m) => m !== "constructor()") : [];
    const props = [...src.matchAll(new RegExp(`${def[1]}\\.([A-Za-z_$][\\w$]*)\\s*=`, "g"))].map((m) => m[1]);
    exp = [...new Set([...methods, ...props])];
  }
  add(p, "src", {
    title: path.basename(p),
    summary: SRC_DESC[p] || "",
    headings: jsOutline(src),
    tags: exp,
    text: clip(exp.join(" ") + " " + jsComments(src), TEXT_CAP),
    kind: "Source module",
    facts: [["Lines", String(lineCount(src))], [def && !jsExports(src).length ? `Exports (${def[1]})` : "Exports", exp.length ? exp.slice(0, 12).join(", ") + (exp.length > 12 ? ` +${exp.length - 12} more` : "") : "—"]],
  });
}

// 3) Tests
for (const p of files.filter((f) => /^test\/.*\.test\.js$/.test(f))) {
  const src = read(p);
  const o = testOutline(src);
  const suites = o.headings.filter((h) => h.lvl === 1).map((h) => h.t);
  add(p, "tests", {
    title: path.basename(p),
    summary: `Jest suite${suites.length > 1 ? "s" : ""} ${suites.map((s) => `“${s}”`).join(", ")}: ${plural(o.count, "test")}${o.each ? ` (${o.each} of them table-driven)` : ""} in ${plural(o.headings.length, "describe block")}.`,
    headings: o.headings,
    text: clip(o.headings.map((h) => h.t).join(" · ") + " · " + o.names.join(" · "), TEXT_CAP),
    kind: "Test suite",
    facts: [["Tests", String(o.count) + (o.each ? ` (${o.each} table-driven)` : "")], ["Describe blocks", String(o.headings.length)], ["Lines", String(lineCount(src))]],
  });
}

// 4) Samples
for (const p of files.filter((f) => f.startsWith("samples/") && f !== "samples/utils.js")) {
  const src = read(p);
  if (p.endsWith(".html")) {
    add(p, "samples", { title: path.basename(p), summary: "Browser version of the logon sample: loads the SDK bundle in a web page and logs on to Campaign.", kind: "Sample (browser)", text: stripTags(src).slice(0, 2000), facts: [["Lines", String(lineCount(src))]] });
    continue;
  }
  const s = sampleInfo(src);
  const name = path.basename(p, ".js");
  add(p, "samples", {
    title: name.replace(/^(\d+) - /, "$1 · ").replace(/ - /g, " · "),
    summary: (SAMPLE_DESC[p] || (s.summary ? s.summary.replace(/\.?$/, ".") : "")) + (s.headings.length ? ` Contains ${plural(s.headings.length, "sample")}.` : ""),
    headings: s.headings,
    tags: s.labels,
    text: clip(s.headings.map((h) => h.t).join(" · ") + " " + s.labels.join(" "), TEXT_CAP),
    kind: "Sample",
    facts: [["Samples", String(s.headings.length)], ["Run", `node "${p}"`], ["Needs", "ACC_URL, ACC_USER and ACC_PASSWORD environment variables"]],
  });
}

// 5) Everything else
function metaGroup(p) {
  if (/(^|\/)(AGENTS|CLAUDE)\.md$/.test(p) || /^(ai-docs|openspec|\.cursor|\.github\/(skills|prompts))\//.test(p)) return "ai";
  if (/^(README|MIGRATION|CODE_OF_CONDUCT)\.md$|^(LICENSE|COPYRIGHT)$|^\.github\/[^/]+\.md$/.test(p)) return "project";
  if (/^docs\//.test(p)) return "docs-site";
  if (/^samples\//.test(p)) return "samples";
  if (/^test\//.test(p)) return "tests";
  return "build";
}
for (const p of files) {
  if (items[p]) continue;
  const gid = metaGroup(p);
  const base = { kind: "File", summary: META_DESC[p] || "" };
  if (/\.md$/.test(p)) {
    const d = markdownDoc(p);
    let title = d.title;
    if (/SKILL\.md$/.test(p)) title = `Skill: ${d.data.name || path.basename(path.dirname(p))}`;
    else if (/(AGENTS|CLAUDE)\.md$/.test(p)) title = p;
    else if (/\.prompt\.md$|\.cursor\/commands\//.test(p)) title = `${p.startsWith(".cursor") ? "Cursor command" : "Copilot prompt"}: ${path.basename(p).replace(/(\.prompt)?\.md$/, "")}`;
    add(p, gid, { ...base, title, subtitle: title !== p ? p : null, summary: META_DESC[p] || d.summary, headings: d.headings, text: d.text, kind: "Markdown" });
  } else if (p === "package.json") {
    const pkg = JSON.parse(read(p));
    add(p, gid, {
      ...base,
      title: "package.json",
      summary: `npm package ${pkg.name}@${pkg.version} — ${pkg.description}. Requires Node.js ${pkg.engines?.node || "?"}.`,
      headings: lines(read(p)).map((l, i) => { const m = l.match(/^ {2}"([^"]+)":/); return m ? { t: m[1], l: i + 1, lvl: 1 } : null; }).filter(Boolean),
      tags: Object.keys(pkg.dependencies || {}).concat(Object.keys(pkg.devDependencies || {})),
      facts: [["Version", pkg.version], ["Dependencies", Object.keys(pkg.dependencies || {}).join(", ")]].concat(Object.entries(pkg.scripts || {}).map(([k, v]) => [`npm run ${k}`, v])),
      kind: "npm manifest",
    });
  } else if (/^\.github\/workflows\/.*\.ya?ml$/.test(p)) {
    const y = read(p);
    const name = (y.match(/^name:\s*"?([^"\n]+)"?/m) || [])[1] || path.basename(p);
    add(p, gid, {
      ...base,
      title: `Workflow: ${name}`,
      subtitle: p,
      summary: (WORKFLOWS[p] || {}).summary || "",
      facts: (WORKFLOWS[p] || {}).facts || [],
      headings: lines(y).map((l, i) => { const m = l.match(/^\s{0,4}-?\s*name:\s*(.+)$/); return m ? { t: m[1].replace(/^["']|["']$/g, ""), l: i + 1, lvl: 2 } : null; }).filter(Boolean),
      kind: "CI workflow",
    });
  } else {
    let headings = [];
    if (/\.js$/.test(p) && fs.existsSync(path.join(ROOT, p)) && p !== "index.html") headings = jsOutline(read(p), { methods: false });
    if (p === "docs/_data/navigation.yml") base.lowRank = true;
    if (p === "docs/_data/navigation.yml") headings = lines(read(p)).map((l, i) => { const m = l.match(/^(\s*)- name:\s*(.+)$/); return m && m[2] !== "--" ? { t: decode(m[2]), l: i + 1, lvl: m[1] ? 2 : 1 } : null; }).filter(Boolean);
    const ext = path.extname(p).slice(1).toLowerCase();
    add(p, gid, {
      ...base,
      title: path.basename(p),
      subtitle: p.includes("/") ? p : null,
      headings,
      kind: { png: "Image", svg: "Image", css: "Stylesheet", yml: "YAML", yaml: "YAML", json: "JSON", js: "JavaScript", html: "HTML" }[ext] || "File",
      site: p === "docs/404.html" ? SITE + "404.html" : null,
      image: ["png", "svg"].includes(ext) ? p.split("/").map(encodeURIComponent).join("/") : null,
    });
  }
}

// Relationships: by name (src <-> test) + manual map, made symmetric
const link = (a, b) => {
  if (!items[a] || !items[b] || a === b) return;
  if (!items[a].related.includes(b)) items[a].related.push(b);
  if (!items[b].related.includes(a)) items[b].related.push(a);
};
for (const p of Object.keys(items)) {
  const m = p.match(/^src\/([^/]+)\.js$/);
  if (m) files.filter((f) => f.startsWith(`test/${m[1]}.`) && f.endsWith(".test.js")).forEach((t) => link(p, t));
}
for (const [a, list] of Object.entries(RELATED)) list.forEach((b) => link(a, b));
for (const p of Object.keys(items)) {
  const m = p.match(/^(.*\/)?CLAUDE\.md$/);
  if (m) link(p, (m[1] || "") + "AGENTS.md");
  const s = p.match(/^\.github\/skills\/([^/]+)\/SKILL\.md$/);
  if (s) link(p, `.cursor/skills/${s[1]}/SKILL.md`);
  const pr = p.match(/^\.github\/prompts\/(.+)\.prompt\.md$/);
  if (pr) link(p, `.cursor/commands/${pr[1]}.md`);
}

const missing = files.filter((f) => !items[f]);
if (missing.length) throw new Error("Files not indexed: " + missing.join(", "));

const pkg = JSON.parse(read("package.json"));
const data = {
  repo: REPO,
  branch: BRANCH,
  repoUrl: `https://github.com/${REPO}`,
  site: SITE,
  version: pkg.version,
  generated: new Date().toISOString().slice(0, 10),
  cats: CATS,
  groups: groups.filter((g) => g.items.length),
  items,
};

const json = JSON.stringify(data).replace(/</g, "\\u003c");
const template = read("tools/index.template.html");
fs.writeFileSync(path.join(ROOT, "index.html"), template.replace("/*__DATA__*/null", () => json).replace(/__REPO_URL__/g, `https://github.com/${REPO}`));
console.log(`index.html: ${Object.keys(items).length} files in ${data.groups.length} sections (${(json.length / 1024).toFixed(0)} KB of data)`);
