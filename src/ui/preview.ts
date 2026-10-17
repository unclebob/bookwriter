import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { divisionOpener, transformBody } from "../export/export";
import {
  clampHeadingLevel,
  codeSpanRanges,
  divisions,
  effectiveFront,
  insideSpan,
  startsNewPage,
  stepFence,
  type Division,
  type Fence,
  type TreeNode,
} from "../internals/model";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("md", markdown);
hljs.registerLanguage("python", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);

const ALIASES: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  yml: "yaml",
  md: "markdown",
  sh: "bash",
  html: "xml",
};

const md = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
  highlight(code, language) {
    const name = ALIASES[language] ?? language;
    if (name && hljs.getLanguage(name)) {
      return hljs.highlight(code, { language: name }).value;
    }
    return "";
  },
});
md.use(footnote);

md.core.ruler.push("image_size", (state) => {
  for (const token of state.tokens) {
    if (token.type !== "inline" || !token.children) continue;
    const children = token.children;
    for (let i = 0; i < children.length; i++) {
      const image = children[i];
      const next = children[i + 1];
      if (image.type !== "image" || next?.type !== "text") continue;
      const match = /^\{([^{}]*)\}/.exec(next.content);
      if (!match) continue;
      const style = imageSizeStyle(match[1]);
      if (!style) continue;
      image.attrSet("style", style);
      const rest = next.content.slice(match[0].length);
      if (rest.length === 0) children.splice(i + 1, 1);
      else next.content = rest;
    }
  }
});

function cssLength(value: string): string | null {
  if (!/^[\d.]+(%|cm|mm|in|px|pt|em|rem)?$/.test(value)) return null;
  if (/^[\d.]+$/.test(value)) return `${value}px`;
  return value;
}

function imageSizeStyle(block: string): string | null {
  const width = /(?:^|\s)width=(\S+)/.exec(block);
  const height = /(?:^|\s)height=(\S+)/.exec(block);
  const parts: string[] = [];
  const widthValue = width ? cssLength(width[1]) : null;
  const heightValue = height ? cssLength(height[1]) : null;
  if (widthValue) parts.push(`width: ${widthValue}`);
  if (heightValue) parts.push(`height: ${heightValue}`);
  return parts.length === 0 ? null : parts.join("; ");
}

const renderToken = md.renderer.renderToken.bind(md.renderer);
md.renderer.renderToken = (tokens, idx, options) => {
  const token = tokens[idx];
  if (token.nesting === 1 && token.map) {
    token.attrSet("data-line", String(token.map[0]));
    token.attrSet("data-end", String(token.map[1]));
  }
  return renderToken(tokens, idx, options);
};

export type TextRun = { src: number; text: string; block: boolean };

type RenderEnv = { runs?: TextRun[] };

const renderText = md.renderer.rules.text;
if (renderText) {
  md.renderer.rules.text = (tokens, idx, options, env, self) => {
    const html = renderText(tokens, idx, options, env, self);
    return stampText(html, env as RenderEnv, tokens[idx].content);
  };
}

const renderCode = md.renderer.rules.code_inline;
if (renderCode) {
  md.renderer.rules.code_inline = (tokens, idx, options, env, self) => {
    const html = renderCode(tokens, idx, options, env, self);
    return stampCode(html, env as RenderEnv, tokens[idx].content);
  };
}

function stampText(html: string, env: RenderEnv, content: string): string {
  if (content.length === 0) return html;
  const run = takeRun(env, content);
  if (!run) return html;
  return `<span data-src="${run.src}">${html}</span>`;
}

function stampCode(html: string, env: RenderEnv, content: string): string {
  if (content.length === 0) return html;
  const run = takeRun(env, content);
  if (!run) return html;
  return html.replace(/<code(?=[\s>])/, `<code data-src="${run.src}"`);
}

function takeRun(env: RenderEnv, content: string): TextRun | null {
  const runs = env.runs ?? [];
  const run = runs[0];
  if (!matchedRun(run, content)) {
    env.runs = [];
    return null;
  }
  runs.shift();
  return run;
}

function matchedRun(run: TextRun | undefined, content: string): run is TextRun {
  return run != null && run.text === content;
}

function stampBlock(name: string): void {
  const rule = md.renderer.rules[name];
  if (!rule) return;
  md.renderer.rules[name] = (tokens, idx, options, env, self) => {
    const html = rule(tokens, idx, options, env, self);
    const sourced = stampCode(html, env as RenderEnv, tokens[idx].content);
    return stampLines(sourced, tokens[idx].map);
  };
}

function stampLines(html: string, map: [number, number] | null): string {
  if (!map) return html;
  return html.replace(/^(\s*)<([A-Za-z0-9-]+)/, `$1<$2 data-line="${map[0]}" data-end="${map[1]}"`);
}
stampBlock("fence");
stampBlock("code_block");

export type Rendered = {
  html: string;
  warnings: string[];
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function recordInlineNote(content: string, count: { n: number }, notes: string[]): string {
  count.n += 1;
  const label = `__inline_${count.n}`;
  notes.push(`[^${label}]: ${content}`);
  return `[^${label}]`;
}

function replaceInlineNotes(line: string, count: { n: number }, notes: string[]): string {
  const spans = codeSpanRanges(line);
  return line.replace(/\^\[([^\]]*)\]/g, (match, content: string, offset: number) => {
    if (insideSpan(offset, spans)) return match;
    return recordInlineNote(content, count, notes);
  });
}

function appendDefinedNotes(text: string, notes: string[]): string {
  if (!notes.length) return text;
  const base = text.endsWith("\n") ? text : text + "\n";
  return `${base}\n${notes.join("\n")}\n`;
}

function expandInlineNotes(body: string): { text: string; warnings: string[] } {
  const warnings: string[] = [];
  const out: string[] = [];
  const notes: string[] = [];
  const count = { n: 0 };
  let fence: Fence | null = null;

  for (const line of body.split("\n")) {
    const step = stepFence(line, fence);
    fence = step.fence;
    out.push(step.fenced ? line : replaceInlineNotes(line, count, notes));
  }
  if (fence) warnings.push("Unclosed code fence.");
  return { text: appendDefinedNotes(out.join("\n"), notes), warnings };
}

function collectRefs(line: string, spans: Array<[number, number]>, referenced: string[]): void {
  for (const match of line.matchAll(/\[\^([^\]]+)\]/g)) {
    if (!insideSpan(match.index ?? 0, spans)) referenced.push(match[1]);
  }
}

function noteLabels(line: string, defined: Set<string>, referenced: string[]): void {
  const spans = codeSpanRanges(line);
  const definition = /^\[\^([^\]]+)\]:/.exec(line);
  if (definition && !insideSpan(definition.index ?? 0, spans)) {
    defined.add(definition[1]);
    return;
  }
  collectRefs(line, spans, referenced);
}

function missingNotes(body: string): string[] {
  const defined = new Set<string>();
  const referenced: string[] = [];
  let fence: Fence | null = null;
  for (const line of body.split("\n")) {
    const step = stepFence(line, fence);
    fence = step.fence;
    if (!step.fenced) noteLabels(line, defined, referenced);
  }
  return referenced.filter((label) => !defined.has(label));
}

type MdToken = { type: string; content: string; children?: MdToken[] | null };

type Scan = { source: string; pos: number; runs: TextRun[]; failed: boolean };

/** Visible slices of `source`, in reading order. `src` is an offset into `source`. */
export function textRuns(source: string): TextRun[] {
  const scan: Scan = { source, pos: 0, runs: [], failed: false };
  walkTokens(md.parse(source, { docId: "runs" }) as MdToken[], scan);
  return scan.runs;
}

function walkTokens(tokens: MdToken[], scan: Scan): void {
  for (const token of tokens) {
    if (scan.failed) return;
    collectToken(token, scan);
  }
}

function collectToken(token: MdToken, scan: Scan): void {
  if (token.type === "image") return;
  if (isRun(token)) recordRun(token, scan);
  else walkChildren(token, scan);
}

function isRun(token: MdToken): boolean {
  return token.type === "text" || token.type === "code_inline" || token.type === "fence" || token.type === "code_block";
}

function walkChildren(token: MdToken, scan: Scan): void {
  if (token.children) walkTokens(token.children, scan);
}

function recordRun(token: MdToken, scan: Scan): void {
  if (token.content.length === 0) return;
  const at = locateContent(scan.source, token.content, scan.pos);
  if (at < 0) {
    scan.failed = true;
    return;
  }
  scan.runs.push({ src: at, text: token.content, block: isBlock(token) });
  if (at >= scan.pos) scan.pos = at + token.content.length;
}

function isBlock(token: MdToken): boolean {
  return token.type === "fence" || token.type === "code_block";
}

function locateContent(source: string, content: string, pos: number): number {
  const forward = source.indexOf(content, pos);
  if (forward >= 0) return forward;
  return source.lastIndexOf(content, pos);
}

export function renderSection(node: TreeNode, ancestors: TreeNode[], division?: Division): Rendered {
  const front = effectiveFront(
    node.header.role,
    ancestors.map((ancestor) => ancestor.header),
  );
  const depth = ancestors.length + 1;
  const warnings: string[] = [];
  const titleLevel = clampHeadingLevel(depth);
  if (depth > 6) warnings.push(`"${node.header.title}" is deeper than heading level 6.`);

  const shifted = transformBody(node.body, { depth, front: false });
  warnings.push(...shifted.warnings);
  const expanded = expandInlineNotes(shifted.text);
  warnings.push(...expanded.warnings.filter((warning) => !warnings.includes(warning)));

  const missing = missingNotes(node.body);
  for (const label of missing) warnings.push(`Footnote [^${label}] has no definition.`);

  let bodyHtml = md.render(expanded.text, { docId: node.header.id, runs: textRuns(node.body) });
  if (missing.length) {
    const items = missing
      .map((label) => `<li class="missing-fn">Missing note [^${escapeHtml(label)}].</li>`)
      .join("");
    bodyHtml += `<ul class="missing-notes">${items}</ul>`;
  }
  if (warnings.some((warning) => warning.startsWith("Unclosed"))) {
    bodyHtml = `<p class="broken-fence">Unclosed code fence.</p>` + bodyHtml;
  }

  const title = escapeHtml(node.header.title);
  const opener = division ? divisionOpener(division) : "";
  const klass = sectionClass(front, node.kind === "group", startsNewPage(node));
  const kicker = front ? `<p class="kicker">Front matter</p>` : "";
  const html = `<section class="${klass}" data-id="${escapeHtml(node.header.id)}" data-depth="${titleLevel.level}">${kicker}${opener}<h${titleLevel.level}>${title}</h${titleLevel.level}>${bodyHtml}</section>`;
  return { html, warnings };
}

function sectionClass(front: boolean, group: boolean, breaks: boolean): string {
  const matter = front ? " front" : "";
  const folder = group ? " folder" : "";
  const page = breaks ? " break" : "";
  return `rendered-section${matter}${folder}${page}`;
}

/** Shown in the reading view wherever a node starts a new page. */
function pageBreakMark(): string {
  return `<div class="page-break" role="separator">Page break</div>`;
}

function renderNode(node: TreeNode, ancestors: TreeNode[], numbered: Map<string, Division>): Rendered {
  if (node.kind === "group") return renderGroup(node, ancestors, numbered);
  return renderSection(node, ancestors, numbered.get(node.header.id));
}

/** The manuscript in tree order, as one reading view. Trash is the caller's to leave out. */
export function renderBook(nodes: TreeNode[]): Rendered {
  const warnings: string[] = [];
  const numbered = divisions(nodes);
  const parts: string[] = [];
  nodes.forEach((node, index) => {
    if (index > 0 && startsNewPage(node)) parts.push(pageBreakMark());
    const rendered = renderNode(node, [], numbered);
    warnings.push(...rendered.warnings);
    parts.push(rendered.html);
  });
  return { html: parts.join("\n"), warnings };
}

export function renderGroup(
  node: TreeNode,
  ancestors: TreeNode[] = [],
  numbered: Map<string, Division> = divisions([node]),
): Rendered {
  const own = renderSection(node, ancestors, numbered.get(node.header.id));
  const warnings = [...own.warnings];
  const parts = [own.html];
  for (const child of node.children) {
    if (startsNewPage(child)) parts.push(pageBreakMark());
    const rendered = renderNode(child, [...ancestors, node], numbered);
    parts.push(rendered.html);
    warnings.push(...rendered.warnings);
  }
  return { html: parts.join("\n"), warnings };
}
