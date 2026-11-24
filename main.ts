// mend — a fresh implementation of SPEC.md (version 1), written from the spec alone.
//
// mend takes one patch an AI model wrote — a unified diff, SEARCH/REPLACE blocks,
// a V4A patch, or JSON edits — and applies it to the tree of text files in the
// working directory. Every edit lands or nothing does: a failed edit is reported
// and the files on disk stay exactly as they were. What changed is printed one
// path per line, then a summary line, and the exit code says how it went.
//
// Run it as: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//   --format=NAME  unified | search-replace | v4a | json | auto (the default)
//   --check        work everything out but write nothing
//   --strict       match lines exactly, no whitespace forgiveness
//   PATCH          patch file, or stdin when absent or `-`
//
// Node 22, standard library only. When MAKEFUN_ENV_URL is set the trial runner
// takes over instead (see the last lines of this file); keep that hand-over and
// runner.ts as the kit has them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const KNOWN_FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** The patch cannot be read in its format; `at` is the 1-based patch line. */
class PatchProblem extends Error {
  readonly at: number;
  constructor(at: number) {
    super(`parse ${at}`);
    this.at = at;
  }
}

/** One edit failed; `code` is the failure code, `path` the path it concerns. */
class EditFault extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

const isBlank = (s: string): boolean => s.trim() === '';
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const leadOf = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** SPEC.md section 3: a path is safe when it is not empty, not absolute, holds no
 *  backslash, and none of its segments is empty, `.` or `..`. */
function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// How a file's text is shaped: its lines, its line break, whether it ends with one
// ---------------------------------------------------------------------------

interface FileShape {
  lines: string[];
  br: string;
  end: boolean;
}

function shapeOf(text: string): FileShape {
  if (text === '') return { lines: [], br: '\n', end: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const end = text.endsWith(br);
  if (end) parts.pop();
  return { lines: parts, br, end };
}

function textOf(f: FileShape): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.end ? f.br : '');
}

// ---------------------------------------------------------------------------
// Matching old lines in a file (SPEC.md section 5)
// ---------------------------------------------------------------------------

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return stripTrail(s);
  return stripTrail(s.replace(/^[ \t]+/, ''));
}

/** Every start position where `old` occurs in `file` at one tier. */
function occurrencesAt(file: string[], old: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const out: number[] = [];
  if (old.length === 0 || old.length > file.length) return out;
  for (let i = from; i + old.length <= file.length; i++) {
    if (eofOnly && i + old.length !== file.length) continue;
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (normLine(file[i + j] as string, tier) !== normLine(old[j] as string, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) where `old` occurs at or
 *  after `from`, with every occurrence there. `eofOnly` keeps only occurrences
 *  that end at the file's last line. */
function locate(
  file: string[],
  old: string[],
  strict: boolean,
  from: number,
  eofOnly: boolean,
): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const at = occurrencesAt(file, old, t, from, eofOnly);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** One line of new text. `ctx` names its index in the old lines when it is a
 *  context line (written as the file's own matched line); null when it is added. */
interface Fresh {
  text: string;
  ctx: number | null;
}

/** Replace `oldLen` lines at `start` with `fresh`, keeping the file's own break
 *  and final-break flag. Context lines come from the file; at tier 2 every other
 *  line is re-indented from the old lines' leading whitespace to the file's. */
function spliceLines(file: FileShape, start: number, oldLen: number, fresh: Fresh[], tier: number, old: string[]): FileShape {
  const pOld = old.length > 0 ? leadOf(old[0] as string) : '';
  const pFile = old.length > 0 ? leadOf(file.lines[start] as string) : '';
  const made = fresh.map((f) => {
    if (f.ctx !== null) return file.lines[start + f.ctx] as string;
    if (tier !== 2) return f.text;
    if (f.text === '' || f.text.trim() === '') return f.text;
    if (!f.text.startsWith(pOld)) return f.text;
    return pFile + f.text.slice(pOld.length);
  });
  return {
    lines: [...file.lines.slice(0, start), ...made, ...file.lines.slice(start + oldLen)],
    br: file.br,
    end: file.end,
  };
}

// ---------------------------------------------------------------------------
// The tree as the edits leave it
// ---------------------------------------------------------------------------

interface Workbench {
  original(p: string): string | null;
  current(p: string): string | null;
  set(p: string, v: string | null): void;
  live: Map<string, string | null>;
  snapshot(): Map<string, string | null>;
  restore(s: Map<string, string | null>): void;
}

/** Originals are read lazily from disk (a path that is not a regular file counts
 *  as absent); `live` holds every path an edit has touched, null meaning deleted. */
function makeWorkbench(): Workbench {
  const orig = new Map<string, string | null>();
  const live = new Map<string, string | null>();
  const original = (p: string): string | null => {
    if (!orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      orig.set(p, v);
    }
    return orig.get(p) as string | null;
  };
  const current = (p: string): string | null => (live.has(p) ? (live.get(p) as string | null) : original(p));
  return {
    original,
    current,
    live,
    set(p: string, v: string | null): void {
      live.set(p, v);
    },
    snapshot(): Map<string, string | null> {
      return new Map(live);
    },
    restore(s: Map<string, string | null>): void {
      live.clear();
      for (const [k, v] of s) live.set(k, v);
    },
  };
}

// ---------------------------------------------------------------------------
// Edits, as plain data. Parsing produces these; applying interprets them.
// ---------------------------------------------------------------------------

/** One body line of a hunk or chunk: ` ` context, `-` old, `+` new, `\` marker. */
interface BodyLine {
  mark: ' ' | '-' | '+' | '\\';
  text: string;
  line: number;
}

interface Hunk {
  /** Old start line from the header (1-based; 0 when the hunk only adds). */
  start: number;
  old: string[];
  fresh: Fresh[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noBreakAfterLast: boolean;
  /** A `\` line follows the hunk's last `+` line; null when it has no `+` line. */
  plusNoBreak: boolean | null;
}

interface Chunk {
  anchor: string | null;
  eof: boolean;
  old: string[];
  fresh: Fresh[];
}

type Edit =
  | { kind: 'uni'; oldPath: string | null; newPath: string | null; mode: 'create' | 'delete' | 'move' | 'change'; hunks: Hunk[] }
  | { kind: 'sr'; path: string; old: string[]; fresh: string[] }
  | { kind: 'vadd'; path: string; lines: string[] }
  | { kind: 'vdel'; path: string }
  | { kind: 'vupd'; path: string; moveTo: string | null; chunks: Chunk[] }
  | { kind: 'jcreate'; path: string; text: string }
  | { kind: 'jreplace'; path: string; oldStr: string; newStr: string }
  | { kind: 'jinsert'; path: string; at: number; text: string };

/** Split a hunk/chunk body into old lines and new lines with context mapping. */
function splitBody(body: BodyLine[]): { old: string[]; fresh: Fresh[] } {
  const old: string[] = [];
  const fresh: Fresh[] = [];
  let oIdx = 0;
  for (const b of body) {
    if (b.mark === ' ') {
      old.push(b.text);
      fresh.push({ text: b.text, ctx: oIdx });
      oIdx++;
    } else if (b.mark === '-') {
      old.push(b.text);
      oIdx++;
    } else if (b.mark === '+') {
      fresh.push({ text: b.text, ctx: null });
    }
  }
  return { old, fresh };
}

/** A hunk from its body lines. A `\` line must follow a context, old or new line. */
function buildHunk(start: number, body: BodyLine[]): Hunk {
  for (let k = 0; k < body.length; k++) {
    if (body[k]!.mark === '\\') {
      const prev = k === 0 ? undefined : body[k - 1];
      if (prev === undefined || prev.mark === '\\') throw new PatchProblem(body[k]!.line);
    }
  }
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < body.length; k++) {
    if (body[k]!.mark === ' ' || body[k]!.mark === '+') lastCtxPlus = k;
    if (body[k]!.mark === '+') lastPlus = k;
  }
  const { old, fresh } = splitBody(body);
  return {
    start,
    old,
    fresh,
    noBreakAfterLast: lastCtxPlus >= 0 && body[lastCtxPlus + 1] !== undefined && body[lastCtxPlus + 1]!.mark === '\\',
    plusNoBreak: lastPlus < 0 ? null : body[lastPlus + 1] !== undefined && body[lastPlus + 1]!.mark === '\\',
  };
}

function buildChunk(anchor: string | null, eof: boolean, body: BodyLine[]): Chunk {
  const { old, fresh } = splitBody(body);
  return { anchor, eof, old, fresh };
}

// ---------------------------------------------------------------------------
// Format detection (SPEC.md section 4)
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => stripTrail(l) === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

function jsonEditOf(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const p = o.path;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    return { kind: 'jcreate', path: p, text: o.file_text };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    return { kind: 'jreplace', path: p, oldStr: o.old_str, newStr: o.new_str === undefined ? '' : o.new_str };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    return { kind: 'jinsert', path: p, at: o.insert_line, text: o.new_str };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new PatchProblem(1);
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new PatchProblem(first + 1);
    }
    if (!Array.isArray(v)) throw new PatchProblem(first + 1);
    const edits: Edit[] = [];
    for (const item of v) {
      const e = jsonEditOf(item);
      if (e === null) throw new PatchProblem(first + 1);
      edits.push(e);
    }
    return edits;
  }
  const edits: Edit[] = [];
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEditOf(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new PatchProblem(i + 1);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

/** The path after `--- ` or `+++ `: text after the four characters, up to the
 *  first tab, surrounding spaces removed, a leading `a/` or `b/` removed. */
function unifiedPath(raw: string): string {
  const tab = raw.indexOf('\t');
  const head = (tab >= 0 ? raw.slice(0, tab) : raw).trim();
  if (head.startsWith('a/') || head.startsWith('b/')) return head.slice(2);
  return head;
}

interface UniSection {
  fromDiff: { old: string; next: string } | null;
  dashOld: string | null;
  dashNew: string | null;
  renOld: string | null;
  renNew: string | null;
  isNew: boolean;
  isDel: boolean;
  hunks: Hunk[];
  seenHunk: boolean;
}

function sectionToEdit(s: UniSection): Edit {
  const oldRaw = s.dashOld ?? s.renOld ?? s.fromDiff?.old;
  const newRaw = s.dashNew ?? s.renNew ?? s.fromDiff?.next;
  const oldPath = oldRaw === undefined || oldRaw === '/dev/null' ? null : oldRaw;
  const newPath = newRaw === undefined || newRaw === '/dev/null' ? null : newRaw;
  if (oldPath === null || s.isNew) {
    return { kind: 'uni', oldPath, newPath, mode: 'create', hunks: s.hunks };
  }
  if (newPath === null || s.isDel) {
    return { kind: 'uni', oldPath, newPath, mode: 'delete', hunks: s.hunks };
  }
  if (oldPath !== newPath) {
    return { kind: 'uni', oldPath, newPath, mode: 'move', hunks: s.hunks };
  }
  return { kind: 'uni', oldPath, newPath, mode: 'change', hunks: s.hunks };
}

function parseUnified(lines: string[]): Edit[] {
  const hunkHead = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const diffHead = /^diff --git a\/(\S+) b\/(\S+)\s*$/;
  const sections: UniSection[] = [];
  const freshSection = (): UniSection => ({
    fromDiff: null,
    dashOld: null,
    dashNew: null,
    renOld: null,
    renNew: null,
    isNew: false,
    isDel: false,
    hunks: [],
    seenHunk: false,
  });
  let cur: UniSection | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i] as string;
    if (line.startsWith('diff --git ')) {
      const m = diffHead.exec(line);
      if (m === null) throw new PatchProblem(i + 1);
      cur = freshSection();
      cur.fromDiff = { old: m[1] as string, next: m[2] as string };
      sections.push(cur);
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      const nxt = lines[i + 1];
      if (nxt !== undefined && nxt.startsWith('+++ ')) {
        if (cur === null || cur.seenHunk) {
          cur = freshSection();
          sections.push(cur);
        }
        cur.dashOld = unifiedPath(line.slice(4));
        cur.dashNew = unifiedPath(nxt.slice(4));
        i += 2;
        continue;
      }
      if (cur !== null && !cur.seenHunk) throw new PatchProblem(i + 2);
      i++;
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (cur !== null && !cur.seenHunk) cur.dashNew = unifiedPath(line.slice(4));
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = hunkHead.exec(line);
      if (m === null || cur === null) throw new PatchProblem(i + 1);
      const start = parseInt(m[1] as string, 10);
      cur.seenHunk = true;
      i++;
      const body: BodyLine[] = [];
      while (i < n) {
        const b = lines[i] as string;
        if (b.startsWith('--- ') && lines[i + 1] !== undefined && (lines[i + 1] as string).startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          body.push({ mark: (b === '' ? ' ' : b[0]) as BodyLine['mark'], text: b === '' ? '' : b.slice(1), line: i + 1 });
          i++;
        } else {
          break;
        }
      }
      while (body.length > 0 && body[body.length - 1]!.mark === ' ' && body[body.length - 1]!.text === '') {
        body.pop();
      }
      cur.hunks.push(buildHunk(start, body));
      continue;
    }
    if (cur !== null && !cur.seenHunk) {
      if (line.startsWith('rename from ')) cur.renOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.isNew = true;
      else if (line.startsWith('deleted file mode')) cur.isDel = true;
    }
    i++;
  }
  if (sections.length === 0) throw new PatchProblem(1);
  return sections.map(sectionToEdit);
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function parseSr(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let searchFrom = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    let s = -1;
    for (let k = i; k < n; k++) {
      if (stripTrail(lines[k] as string) === '<<<<<<< SEARCH') {
        s = k;
        break;
      }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let k = s - 1; k >= searchFrom; k--) {
      const t = (lines[k] as string).trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new PatchProblem(s + 1);
      path = prevPath;
    }
    let eq = -1;
    for (let k = s + 1; k < n; k++) {
      const t = stripTrail(lines[k] as string);
      if (t === '=======') {
        eq = k;
        break;
      }
      if (t === '<<<<<<< SEARCH' || t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new PatchProblem(s + 1);
    let rep = -1;
    for (let k = eq + 1; k < n; k++) {
      const t = stripTrail(lines[k] as string);
      if (t === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new PatchProblem(s + 1);
    edits.push({ kind: 'sr', path, old: lines.slice(s + 1, eq), fresh: lines.slice(eq + 1, rep) });
    prevPath = path;
    searchFrom = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new PatchProblem(1);
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

function parseV4a(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new PatchProblem(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw new PatchProblem(first + 1);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!isBlank(lines[k] as string)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new PatchProblem(lines.length + 1);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i] as string;
    if (isBlank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i++;
      const raw: string[] = [];
      while (i < last && !isSectionStart(lines[i] as string)) {
        const l = lines[i] as string;
        if (l.startsWith('+')) {
          raw.push(l.slice(1));
          i++;
        } else if (l === '') {
          raw.push('');
          i++;
        } else {
          throw new PatchProblem(i + 1);
        }
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      edits.push({ kind: 'vadd', path, lines: raw });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i++;
      while (i < last && !isSectionStart(lines[i] as string)) {
        if (isBlank(lines[i] as string)) {
          i++;
          continue;
        }
        throw new PatchProblem(i + 1);
      }
      edits.push({ kind: 'vdel', path });
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updLine = i + 1;
      i++;
      while (i < last && isBlank(lines[i] as string)) i++;
      let moveTo: string | null = null;
      if (i < last && (lines[i] as string).startsWith('*** Move to: ')) {
        moveTo = (lines[i] as string).slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: Chunk[] = [];
      let firstChunk = true;
      let open: { anchor: string | null; eof: boolean; body: BodyLine[] } | null = null;
      const closeChunk = (atSectionEnd: boolean): void => {
        if (open === null) return;
        if (atSectionEnd) {
          while (open.body.length > 0 && open.body[open.body.length - 1]!.mark === ' ' && open.body[open.body.length - 1]!.text === '') {
            open.body.pop();
          }
        }
        chunks.push(buildChunk(open.anchor, open.eof, open.body));
        open = null;
      };
      while (i < last) {
        const l = lines[i] as string;
        if (isSectionStart(l)) break;
        if (l === '*** End of File') {
          if (open === null) throw new PatchProblem(i + 1);
          open.eof = true;
          closeChunk(false);
          firstChunk = false;
          i++;
          continue;
        }
        if (l.startsWith('@@')) {
          closeChunk(false);
          const a = l.slice(2).trim();
          open = { anchor: a === '' ? null : a, eof: false, body: [] };
          firstChunk = false;
          i++;
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (open === null) {
            if (!firstChunk) {
              i++;
              continue;
            }
            open = { anchor: null, eof: false, body: [] };
            firstChunk = false;
          }
          open.body.push({
            mark: (l === '' ? ' ' : l[0]) as BodyLine['mark'],
            text: l === '' ? '' : l.slice(1),
            line: i + 1,
          });
          i++;
          continue;
        }
        throw new PatchProblem(i + 1);
      }
      closeChunk(true);
      if (chunks.length === 0 && moveTo === null) throw new PatchProblem(updLine);
      edits.push({ kind: 'vupd', path, moveTo, chunks });
      continue;
    }
    throw new PatchProblem(i + 1);
  }
  if (edits.length === 0) throw new PatchProblem(1);
  return edits;
}

// ---------------------------------------------------------------------------
// Applying edits
// ---------------------------------------------------------------------------

interface MoveRec {
  from: string;
  to: string;
}

/** Apply one section's hunks to a file's text, in order, tracking the drift `d`
 *  between the patch's old line numbers and the file as hunks land. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  let shape = shapeOf(text);
  let d = 0;
  for (const h of hunks) {
    if (h.old.length === 0) {
      const at = Math.min(h.start + d, shape.lines.length);
      const after = spliceLines(shape, at, 0, h.fresh, 0, []);
      shape = { ...after, end: at === shape.lines.length ? !h.noBreakAfterLast : shape.end };
      d += h.fresh.length;
      continue;
    }
    const found = locate(shape.lines, h.old, strict, 0, false);
    if (found === null) throw new EditFault('no-match', path);
    const target = h.start - 1 + d;
    let best = found.at[0] as number;
    for (const p of found.at) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const toEnd = best + h.old.length === shape.lines.length;
    const after = spliceLines(shape, best, h.old.length, h.fresh, found.tier, h.old);
    shape = { ...after, end: toEnd ? !h.noBreakAfterLast : shape.end };
    d += h.fresh.length - h.old.length;
  }
  return textOf(shape);
}

function applyUni(b: Workbench, e: Extract<Edit, { kind: 'uni' }>, strict: boolean, moves: MoveRec[]): void {
  if (e.mode === 'create') {
    const p = e.newPath;
    if (p === null) return;
    if (!isSafePath(p)) throw new EditFault('unsafe', p);
    if (b.current(p) !== null) throw new EditFault('exists', p);
    const plus: string[] = [];
    for (const h of e.hunks) {
      for (const f of h.fresh) if (f.ctx === null) plus.push(f.text);
    }
    let end = false;
    for (let k = e.hunks.length - 1; k >= 0; k--) {
      const pb = e.hunks[k]!.plusNoBreak;
      if (pb !== null) {
        end = !pb;
        break;
      }
    }
    b.set(p, plus.length === 0 ? '' : plus.join('\n') + (end ? '\n' : ''));
    return;
  }
  if (e.mode === 'delete') {
    const p = e.oldPath;
    if (p === null) return;
    if (!isSafePath(p)) throw new EditFault('unsafe', p);
    if (b.current(p) === null) throw new EditFault('missing', p);
    b.set(p, null);
    return;
  }
  const oldP = e.oldPath as string;
  if (!isSafePath(oldP)) throw new EditFault('unsafe', oldP);
  if (e.mode === 'move') {
    const newP = e.newPath as string;
    if (!isSafePath(newP)) throw new EditFault('unsafe', newP);
    if (b.current(oldP) === null) throw new EditFault('missing', oldP);
    if (b.current(newP) !== null) throw new EditFault('exists', newP);
    const result = applyHunks(b.current(oldP) as string, e.hunks, strict, oldP);
    b.set(oldP, null);
    b.set(newP, result);
    moves.push({ from: oldP, to: newP });
    return;
  }
  if (b.current(oldP) === null) throw new EditFault('missing', oldP);
  b.set(oldP, applyHunks(b.current(oldP) as string, e.hunks, strict, oldP));
}

function applySr(b: Workbench, e: Extract<Edit, { kind: 'sr' }>, strict: boolean): void {
  if (!isSafePath(e.path)) throw new EditFault('unsafe', e.path);
  if (e.old.length === 0) {
    if (b.current(e.path) !== null) throw new EditFault('exists', e.path);
    b.set(e.path, e.fresh.length === 0 ? '' : e.fresh.join('\n') + '\n');
    return;
  }
  const cur = b.current(e.path);
  if (cur === null) throw new EditFault('missing', e.path);
  const shape = shapeOf(cur);
  const found = locate(shape.lines, e.old, strict, 0, false);
  if (found === null) throw new EditFault('no-match', e.path);
  if (found.at.length > 1) throw new EditFault('ambiguous', e.path);
  const fresh: Fresh[] = e.fresh.map((t) => ({ text: t, ctx: null }));
  b.set(e.path, textOf(spliceLines(shape, found.at[0] as number, e.old.length, fresh, found.tier, e.old)));
}

function applyVadd(b: Workbench, e: Extract<Edit, { kind: 'vadd' }>): void {
  if (!isSafePath(e.path)) throw new EditFault('unsafe', e.path);
  if (b.current(e.path) !== null) throw new EditFault('exists', e.path);
  b.set(e.path, e.lines.length === 0 ? '' : e.lines.join('\n') + '\n');
}

function applyVdel(b: Workbench, e: Extract<Edit, { kind: 'vdel' }>): void {
  if (!isSafePath(e.path)) throw new EditFault('unsafe', e.path);
  if (b.current(e.path) === null) throw new EditFault('missing', e.path);
  b.set(e.path, null);
}

function applyVupd(b: Workbench, e: Extract<Edit, { kind: 'vupd' }>, strict: boolean, moves: MoveRec[]): void {
  if (!isSafePath(e.path)) throw new EditFault('unsafe', e.path);
  if (e.moveTo !== null && !isSafePath(e.moveTo)) throw new EditFault('unsafe', e.moveTo);
  const cur = b.current(e.path);
  if (cur === null) throw new EditFault('missing', e.path);
  if (e.moveTo !== null && b.current(e.moveTo) !== null) throw new EditFault('exists', e.moveTo);
  let shape = shapeOf(cur);
  let cursor = 0;
  for (const ch of e.chunks) {
    if (ch.anchor !== null) {
      const found = locate(shape.lines, [ch.anchor], strict, cursor, false);
      if (found === null) throw new EditFault('no-match', e.path);
      cursor = (found.at[0] as number) + 1;
    }
    if (ch.old.length === 0) {
      const at = ch.eof ? shape.lines.length : cursor;
      shape = spliceLines(shape, at, 0, ch.fresh.map((f) => ({ text: f.text, ctx: null })), 0, []);
      cursor = at + ch.fresh.length;
      continue;
    }
    const found = locate(shape.lines, ch.old, strict, cursor, ch.eof);
    if (found === null) throw new EditFault('no-match', e.path);
    const at = found.at[0] as number;
    shape = spliceLines(shape, at, ch.old.length, ch.fresh, found.tier, ch.old);
    cursor = at + ch.fresh.length;
  }
  const result = textOf(shape);
  if (e.moveTo !== null) {
    b.set(e.path, null);
    b.set(e.moveTo, result);
    moves.push({ from: e.path, to: e.moveTo });
  } else {
    b.set(e.path, result);
  }
}

function applyJcreate(b: Workbench, e: Extract<Edit, { kind: 'jcreate' }>): void {
  if (!isSafePath(e.path)) throw new EditFault('unsafe', e.path);
  if (b.current(e.path) !== null) throw new EditFault('exists', e.path);
  b.set(e.path, e.text);
}

function applyJreplace(b: Workbench, e: Extract<Edit, { kind: 'jreplace' }>): void {
  if (!isSafePath(e.path)) throw new EditFault('unsafe', e.path);
  const cur = b.current(e.path);
  if (cur === null) throw new EditFault('missing', e.path);
  const nl = cur.indexOf('\n');
  const crlf = nl > 0 && cur[nl - 1] === '\r';
  const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
  const t = norm(cur);
  const old = norm(e.oldStr);
  let count = 0;
  for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count++;
  if (count === 0) throw new EditFault('no-match', e.path);
  if (count > 1) throw new EditFault('ambiguous', e.path);
  const at = t.indexOf(old);
  const out = t.slice(0, at) + norm(e.newStr) + t.slice(at + old.length);
  b.set(e.path, crlf ? out.replaceAll('\n', '\r\n') : out);
}

function applyJinsert(b: Workbench, e: Extract<Edit, { kind: 'jinsert' }>): void {
  if (!isSafePath(e.path)) throw new EditFault('unsafe', e.path);
  const cur = b.current(e.path);
  if (cur === null) throw new EditFault('missing', e.path);
  const shape = shapeOf(cur);
  if (e.at < 0 || e.at > shape.lines.length) throw new EditFault('no-match', e.path);
  const add = splitPatch(e.text);
  const lines = [...shape.lines.slice(0, e.at), ...add, ...shape.lines.slice(e.at)];
  b.set(e.path, textOf({ lines, br: shape.br, end: shape.end }));
}

function applyEdit(b: Workbench, edit: Edit, strict: boolean, moves: MoveRec[]): void {
  switch (edit.kind) {
    case 'uni':
      applyUni(b, edit, strict, moves);
      return;
    case 'sr':
      applySr(b, edit, strict);
      return;
    case 'vadd':
      applyVadd(b, edit);
      return;
    case 'vdel':
      applyVdel(b, edit);
      return;
    case 'vupd':
      applyVupd(b, edit, strict, moves);
      return;
    case 'jcreate':
      applyJcreate(b, edit);
      return;
    case 'jreplace':
      applyJreplace(b, edit);
      return;
    case 'jinsert':
      applyJinsert(b, edit);
      return;
  }
}

// ---------------------------------------------------------------------------
// The command line (SPEC.md sections 1 and 2)
// ---------------------------------------------------------------------------

interface Cli {
  format: string | null;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

function parseCli(argv: string[]): Cli | null {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of argv) {
    if (!ended && a === '--') {
      ended = true;
      continue;
    }
    if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        const v = a.slice('--format='.length);
        if (format !== null || !KNOWN_FORMATS.includes(v)) return null;
        format = v;
      } else if (a === '--check') {
        if (check) return null;
        check = true;
      } else if (a === '--strict') {
        if (strict) return null;
        strict = true;
      } else {
        return null;
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return null;
  return { format, check, strict, patch: pos.length === 0 ? null : (pos[0] as string) };
}

function run(argv: string[]): { code: number; out: string[] } {
  const cli = parseCli(argv);
  if (cli === null) return { code: 2, out: ['error: usage'] };
  let text = '';
  try {
    text = readFileSync(cli.patch === null || cli.patch === '-' ? 0 : cli.patch, 'utf8');
  } catch {
    if (cli.patch !== null && cli.patch !== '-') return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = cli.format === null || cli.format === 'auto' ? detectFormat(lines) : cli.format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines);
    else if (kind === 'search-replace') edits = parseSr(lines);
    else edits = parseV4a(lines);
    if (edits.length === 0) throw new PatchProblem(1);
  } catch (e) {
    if (e instanceof PatchProblem) return { code: 2, out: [`error: parse ${e.at}`] };
    throw e;
  }
  const bench = makeWorkbench();
  const moves: MoveRec[] = [];
  const faults: EditFault[] = [];
  for (const edit of edits) {
    const snap = bench.snapshot();
    try {
      applyEdit(bench, edit, cli.strict, moves);
    } catch (e) {
      if (!(e instanceof EditFault)) throw e;
      bench.restore(snap);
      faults.push(e);
    }
  }
  if (faults.length > 0) {
    return {
      code: 1,
      out: [...faults.map((f) => `error: ${f.code} ${f.path}`), `failed: ${faults.length} of ${edits.length} edits`],
    };
  }
  const moved = new Map<string, string>();
  for (const m of moves) {
    if (
      bench.original(m.from) !== null &&
      bench.current(m.from) === null &&
      bench.original(m.to) === null &&
      bench.current(m.to) !== null
    ) {
      moved.set(m.from, m.to);
    }
  }
  const movedTo = new Set(moved.values());
  const rows: { key: string; line: string }[] = [];
  for (const p of bench.live.keys()) {
    const was = bench.original(p);
    const now = bench.live.get(p) as string | null;
    if (was === now) continue;
    if (moved.has(p) || movedTo.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [from, to] of moved) {
    rows.push({ key: to, line: `R ${from} -> ${to}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  const out = [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  if (!cli.check) {
    for (const p of [...bench.live.keys()].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))) {
      const was = bench.original(p);
      const now = bench.live.get(p) as string | null;
      if (was === now) continue;
      if (now === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out };
}

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(envUrl);
} else {
  const result = run(process.argv.slice(2));
  writeSync(1, result.out.map((l) => `${l}\n`).join(''));
  process.exitCode = result.code;
}
