// main.ts is mend, the CLI SPEC.md specifies: one patch tool for every AI edit format.
//
// It reads a patch in one of four formats (a unified diff, SEARCH/REPLACE blocks, a V4A
// patch, or JSON edits), finds the lines each edit names at the first of three matching
// tiers, and writes every change or none, printing what it changed or why it failed.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this
// file hands over to runner.ts (the last lines below): keep that hand-over and runner.ts
// as they are.

import { mkdirSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const KNOWN_FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** Abort the run with an exit-2 line (usage, missing patch, bad format, parse fault). */
class Abort extends Error {
  readonly line: string;
  constructor(line: string) {
    super(line);
    this.line = line;
  }
}

/** One edit failed; the run reports it and keeps going with the edits after it. */
class EditError extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(code);
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at `\n`, one trailing `\r` removed from each, and no empty
 *  piece after a final `\n`. */
function splitPatchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function isSafePath(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function cmpUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** A file as the spec sees it: its line break, its lines, and whether it ends with one. */
interface Doc {
  eol: string;
  lines: string[];
  trailing: boolean;
}

function readDoc(text: string): Doc {
  if (text === '') return { eol: '\n', lines: [], trailing: false };
  const nl = text.indexOf('\n');
  const eol = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(eol);
  let trailing = false;
  if (text.endsWith(eol)) {
    parts.pop();
    trailing = true;
  }
  return { eol, lines: parts, trailing };
}

function writeDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.eol) + (d.trailing ? d.eol : '');
}

/** The tree as the edits leave it: paths changed so far in `staged` (null: deleted),
 *  everything else read from disk. `relocations` holds the (old, new) pairs of move
 *  edits that succeeded, for the `R` lines of the output. */
class Work {
  private disk = new Map<string, string | null>();
  staged = new Map<string, string | null>();
  relocations: Array<[string, string]> = [];

  read(p: string): string | null {
    if (!this.disk.has(p)) {
      // One read: a missing path, a directory, or an unreadable file all read as
      // "not there", exactly as the statSync-then-read version did.
      let v: string | null = null;
      try {
        v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.disk.set(p, v);
    }
    return this.disk.get(p)!;
  }

  current(p: string): string | null {
    return this.staged.has(p) ? this.staged.get(p)! : this.read(p);
  }
}

type EditFn = (work: Work) => void;

// ---- Section 5: matching lines -------------------------------------------------

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function lineMatches(fileLine: string, oldLine: string, tier: number): boolean {
  if (tier === 0) return fileLine === oldLine;
  if (tier === 1) return trimEndWs(fileLine) === trimEndWs(oldLine);
  return trimBothWs(fileLine) === trimBothWs(oldLine);
}

/** 0-based positions at which `oldLines` occurs in `lines` at `tier`, from `from` on.
 *  Occurrences may overlap. */
function findOccurrences(lines: string[], oldLines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (oldLines.length === 0) return out;
  for (let i = Math.max(0, from); i + oldLines.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (!lineMatches(lines[i + j]!, oldLines[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which `oldLines` occurs, with its positions, or null when it
 *  occurs at no tier. One scan per tier, shared by the callers that need both the
 *  tier and the positions. */
function findAtFirstTier(lines: string[], oldLines: string[], strict: boolean, from: number): { tier: number; spots: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const spots = findOccurrences(lines, oldLines, t, from);
    if (spots.length > 0) return { tier: t, spots };
  }
  return null;
}

/** One line of a hunk or chunk body: context (in both old and new), old-only, new-only. */
type Mark = 'ctx' | 'old' | 'new';
interface BodyLine {
  mark: Mark;
  text: string;
}

/** A line of the replacement text: `fromOld` is the index, in the old lines, of the
 *  file line a context line is written as, or -1 for a line written as the patch has it. */
interface NewLine {
  text: string;
  fromOld: number;
}

/** Split a body into its old lines and its new lines. */
function splitOldNew(body: BodyLine[]): { oldLines: string[]; newLines: NewLine[] } {
  const oldLines: string[] = [];
  const newLines: NewLine[] = [];
  for (const b of body) {
    if (b.mark === 'ctx') {
      newLines.push({ text: b.text, fromOld: oldLines.length });
      oldLines.push(b.text);
    } else if (b.mark === 'old') {
      oldLines.push(b.text);
    } else {
      newLines.push({ text: b.text, fromOld: -1 });
    }
  }
  return { oldLines, newLines };
}

/** The lines that replace the matched run at `at`: context lines come from the file
 *  itself; at tier 2 every other line is re-indented (F, the leading spaces and tabs
 *  of the file's first matched line, takes the place of P, those of the old lines'
 *  first line). */
function buildReplacement(fileLines: string[], at: number, oldLines: string[], newLines: NewLine[], tier: number): string[] {
  let fLead = '';
  let pLead = '';
  if (tier === 2 && oldLines.length > 0) {
    fLead = leadingWs(fileLines[at] ?? '');
    pLead = leadingWs(oldLines[0]!);
  }
  const out: string[] = [];
  for (const item of newLines) {
    if (item.fromOld >= 0) {
      out.push(fileLines[at + item.fromOld]!);
      continue;
    }
    let t = item.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(pLead)) t = fLead + t.slice(pLead.length);
    out.push(t);
  }
  return out;
}

// ---- Section 4: detecting the format -------------------------------------------

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- Section 9: JSON edits -----------------------------------------------------

/** One JSON edit object, or null when it is not one. */
function jsonEditObject(v: unknown): EditFn | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const readExisting = (work: Work): string => {
    if (!isSafePath(p)) throw new EditError('unsafe', p);
    const t = work.current(p);
    if (t === null) throw new EditError('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (work) => {
      if (!isSafePath(p)) throw new EditError('unsafe', p);
      if (work.current(p) !== null) throw new EditError('exists', p);
      work.staged.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (work) => {
      const before = readExisting(work);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const normalize = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = normalize(before);
      const old = normalize(oldStr);
      let count = 0;
      for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditError('no-match', p);
      if (count > 1) throw new EditError('ambiguous', p);
      const at = text.indexOf(old);
      const out = text.slice(0, at) + normalize(newStr) + text.slice(at + old.length);
      work.staged.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const lineNo = o.insert_line;
    const added = splitPatchLines(o.new_str);
    return (work) => {
      const before = readExisting(work);
      const doc = readDoc(before);
      if (lineNo < 0 || lineNo > doc.lines.length) throw new EditError('no-match', p);
      doc.lines.splice(lineNo, 0, ...added);
      work.staged.set(p, writeDoc(doc));
    };
  }
  return null;
}

function parseJsonEdits(text: string, lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Abort('error: parse 1');
  const edits: EditFn[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Abort(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Abort(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEditObject(x);
      if (e === null) throw new Abort(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: EditFn | null = null;
    try {
      e = jsonEditObject(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Abort(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Section 6: unified diffs --------------------------------------------------

interface Hunk {
  oldStart: number;
  body: BodyLine[];
  /** A `\` line follows this hunk's last context or `+` line. */
  noBreakAfterTail: boolean;
  /** A `\` line follows this hunk's last `+` line. */
  noBreakAfterPlus: boolean;
}

interface UniSection {
  oldPath: string;
  newPath: string;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** The path a `--- ` or `+++ ` line names: the text after the four characters, up to
 *  the first tab, with surrounding spaces removed, and one leading `a/` or `b/` removed. */
function headerPath(line: string): string {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = rest.trim();
  if (rest.startsWith('a/') || rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}

/** Turn a hunk body's raw lines into body items, remembering whether a `\` line
 *  follows the last context-or-new item and the last new item. A `\` line refers to
 *  the body line before it. */
function buildHunk(oldStart: number, raw: string[]): Hunk {
  const items: BodyLine[] = [];
  const markedAfter: boolean[] = [];
  for (const rawLine of raw) {
    if (rawLine.startsWith('\\')) {
      if (items.length > 0) markedAfter[items.length - 1] = true;
      continue;
    }
    if (rawLine === '') {
      items.push({ mark: 'ctx', text: '' });
    } else if (rawLine[0] === ' ') {
      items.push({ mark: 'ctx', text: rawLine.slice(1) });
    } else if (rawLine[0] === '-') {
      items.push({ mark: 'old', text: rawLine.slice(1) });
    } else {
      items.push({ mark: 'new', text: rawLine.slice(1) });
    }
    markedAfter.push(false);
  }
  let lastTail = -1;
  let lastPlus = -1;
  for (let k = 0; k < items.length; k++) {
    if (items[k]!.mark === 'ctx' || items[k]!.mark === 'new') lastTail = k;
    if (items[k]!.mark === 'new') lastPlus = k;
  }
  return {
    oldStart,
    body: items,
    noBreakAfterTail: lastTail >= 0 && markedAfter[lastTail] === true,
    noBreakAfterPlus: lastPlus >= 0 && markedAfter[lastPlus] === true,
  };
}

/** Apply a section's hunks in order, each to the result of the ones before it.
 *  `shift` is the running sum over the hunks applied so far of (new lines minus old
 *  lines), and moves the target line of the nearest-occurrence rule. */
function applyHunks(doc: Doc, hunks: Hunk[], strict: boolean, path: string): Doc {
  let shift = 0;
  for (const h of hunks) {
    const { oldLines, newLines } = splitOldNew(h.body);
    if (oldLines.length > 0) {
      const found = findAtFirstTier(doc.lines, oldLines, strict, 0);
      if (found === null) throw new EditError('no-match', path);
      const { tier, spots } = found;
      const target = h.oldStart - 1 + shift;
      let best = spots[0]!;
      for (const s of spots) {
        if (Math.abs(s - target) < Math.abs(best - target)) best = s;
      }
      const touchesEnd = best + oldLines.length === doc.lines.length;
      const repl = buildReplacement(doc.lines, best, oldLines, newLines, tier);
      doc.lines.splice(best, oldLines.length, ...repl);
      if (touchesEnd) doc.trailing = !h.noBreakAfterTail;
    } else {
      const at = Math.max(0, Math.min(h.oldStart + shift, doc.lines.length));
      const touchesEnd = at === doc.lines.length;
      doc.lines.splice(at, 0, ...newLines.map((nl) => nl.text));
      if (touchesEnd) doc.trailing = !h.noBreakAfterTail;
    }
    shift += newLines.length - oldLines.length;
  }
  return doc;
}

function unifiedEdit(s: UniSection, strict: boolean): EditFn {
  return (work) => {
    const oldGone = s.oldPath === '/dev/null';
    const newGone = s.newPath === '/dev/null';
    if (s.isCreate || oldGone) {
      const p = s.newPath;
      if (!isSafePath(p)) throw new EditError('unsafe', p);
      if (work.current(p) !== null) throw new EditError('exists', p);
      const plus: string[] = [];
      let endsWithBreak = true;
      let lastWithPlus: Hunk | null = null;
      for (const h of s.hunks) {
        if (h.body.some((b) => b.mark === 'new')) lastWithPlus = h;
        for (const b of h.body) if (b.mark === 'new') plus.push(b.text);
      }
      if (lastWithPlus !== null) endsWithBreak = !lastWithPlus.noBreakAfterPlus;
      work.staged.set(p, plus.length === 0 ? '' : plus.join('\n') + (endsWithBreak ? '\n' : ''));
      return;
    }
    if (s.isDelete || newGone) {
      const p = s.oldPath;
      if (!isSafePath(p)) throw new EditError('unsafe', p);
      if (work.current(p) === null) throw new EditError('missing', p);
      work.staged.set(p, null);
      return;
    }
    if (s.oldPath !== s.newPath) {
      if (!isSafePath(s.oldPath)) throw new EditError('unsafe', s.oldPath);
      if (!isSafePath(s.newPath)) throw new EditError('unsafe', s.newPath);
      const before = work.current(s.oldPath);
      if (before === null) throw new EditError('missing', s.oldPath);
      if (work.current(s.newPath) !== null) throw new EditError('exists', s.newPath);
      const out = applyHunks(readDoc(before), s.hunks, strict, s.oldPath);
      work.staged.set(s.oldPath, null);
      work.staged.set(s.newPath, writeDoc(out));
      work.relocations.push([s.oldPath, s.newPath]);
      return;
    }
    const p = s.oldPath;
    if (!isSafePath(p)) throw new EditError('unsafe', p);
    const before = work.current(p);
    if (before === null) throw new EditError('missing', p);
    work.staged.set(p, writeDoc(applyHunks(readDoc(before), s.hunks, strict, p)));
  };
}

function parseUnified(lines: string[], strict: boolean): EditFn[] {
  const sections: UniSection[] = [];
  const gitRe = /^diff --git a\/(.+?) b\/(.+)$/;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  let current: UniSection | null = null;
  let headerOpen = false;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = gitRe.exec(line);
      if (m === null) throw new Abort(`error: parse ${i + 1}`);
      current = { oldPath: m[1]!, newPath: m[2]!, isCreate: false, isDelete: false, hunks: [] };
      sections.push(current);
      headerOpen = true;
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (current === null) throw new Abort(`error: parse ${i + 1}`);
      const m = hunkRe.exec(line);
      if (m === null) throw new Abort(`error: parse ${i + 1}`);
      const oldStart = parseInt(m[1]!, 10);
      i += 1;
      const raw: string[] = [];
      while (i < n) {
        const l = lines[i]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
          raw.push(l);
          i += 1;
        } else break;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      current.hunks.push(buildHunk(oldStart, raw));
      headerOpen = false;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (current !== null && headerOpen) {
        current.oldPath = headerPath(line);
        current.newPath = headerPath(lines[i + 1]!);
      } else {
        current = { oldPath: headerPath(line), newPath: headerPath(lines[i + 1]!), isCreate: false, isDelete: false, hunks: [] };
        sections.push(current);
        headerOpen = true;
      }
      i += 2;
      continue;
    }
    if (current !== null && headerOpen) {
      if (line.startsWith('--- ')) throw new Abort(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) current.oldPath = line.slice(12).trim();
      else if (line.startsWith('rename to ')) current.newPath = line.slice(10).trim();
      else if (line.startsWith('new file mode')) current.isCreate = true;
      else if (line.startsWith('deleted file mode')) current.isDelete = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  if (sections.length === 0) throw new Abort('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

// ---- Section 7: SEARCH/REPLACE blocks ------------------------------------------

/** The index of the next line at or after `from` whose trailing whitespace removed
 *  is `marker`, or -1. */
function findMarker(lines: string[], from: number, marker: string): number {
  for (let k = from; k < lines.length; k++) {
    if (lines[k]!.trimEnd() === marker) return k;
  }
  return -1;
}

/** The path of the block whose SEARCH line is `searchAt`: the nearest line before it,
 *  after `lowerBound`, that is not blank and, its surrounding whitespace removed, does
 *  not start with three backticks; that line with its surrounding whitespace removed. */
function findBlockPath(lines: string[], searchAt: number, lowerBound: number): string | null {
  for (let k = searchAt - 1; k >= lowerBound; k--) {
    const l = lines[k]!;
    if (isBlank(l)) continue;
    const t = l.trim();
    if (t.startsWith('```')) continue;
    return t;
  }
  return null;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): EditFn {
  return (work) => {
    if (!isSafePath(path)) throw new EditError('unsafe', path);
    if (oldLines.length === 0) {
      if (work.current(path) !== null) throw new EditError('exists', path);
      work.staged.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = work.current(path);
    if (before === null) throw new EditError('missing', path);
    const doc = readDoc(before);
    const found = findAtFirstTier(doc.lines, oldLines, strict, 0);
    if (found === null) throw new EditError('no-match', path);
    const { tier, spots } = found;
    if (spots.length > 1) throw new EditError('ambiguous', path);
    const repl = buildReplacement(doc.lines, spots[0]!, oldLines, newLines.map((t) => ({ text: t, fromOld: -1 })), tier);
    doc.lines.splice(spots[0]!, oldLines.length, ...repl);
    work.staged.set(path, writeDoc(doc));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): EditFn[] {
  const edits: EditFn[] = [];
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const s = findMarker(lines, i, '<<<<<<< SEARCH');
    if (s < 0) break;
    const eq = findMarker(lines, s + 1, '=======');
    if (eq < 0) throw new Abort(`error: parse ${s + 1}`);
    const rep = findMarker(lines, eq + 1, '>>>>>>> REPLACE');
    if (rep < 0) throw new Abort(`error: parse ${s + 1}`);
    let path = findBlockPath(lines, s, i);
    if (path === null) {
      if (prevPath === null) throw new Abort(`error: parse ${s + 1}`);
      path = prevPath;
    }
    edits.push(searchReplaceEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Abort('error: parse 1');
  return edits;
}

// ---- Section 8: V4A patches ----------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  atEnd: boolean;
  body: BodyLine[];
}

interface V4aUpdate {
  path: string;
  moveTo: string | null;
  chunks: V4aChunk[];
}

interface V4aSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  lineNo: number;
  body: Array<{ text: string; no: number }>;
}

/** Split an Update File section's lines into its chunks (an optional `*** Move to:`
 *  first line, then chunks that start at an `@@` line, or, for the first chunk, at a
 *  body line; `*** End of File` ends a chunk and anchors it to the end of the file). */
function parseV4aUpdate(s: V4aSection): V4aUpdate {
  const lines = s.body;
  let i = 0;
  let moveTo: string | null = null;
  if (lines.length > 0 && lines[0]!.text.startsWith('*** Move to: ')) {
    moveTo = lines[0]!.text.slice(13).trim();
    i = 1;
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  let seenChunk = false;
  const openChunk = (anchor: string | null): void => {
    cur = { anchor, atEnd: false, body: [] };
    chunks.push(cur);
    seenChunk = true;
  };
  while (i < lines.length) {
    const entry = lines[i]!;
    const t = entry.text;
    if (t.startsWith('@@')) {
      const a = t.slice(2).trim();
      openChunk(a === '' ? null : a);
      i += 1;
      continue;
    }
    if (t.trim() === '*** End of File' && !t.startsWith(' ')) {
      if (cur === null) throw new Abort(`error: parse ${entry.no}`);
      cur.atEnd = true;
      cur = null;
      i += 1;
      continue;
    }
    if (t.startsWith('*** Move to: ')) throw new Abort(`error: parse ${entry.no}`);
    if (t.startsWith(' ') || t.startsWith('-') || t.startsWith('+') || t === '') {
      if (cur === null) {
        if (seenChunk) throw new Abort(`error: parse ${entry.no}`);
        openChunk(null);
      }
      if (t.startsWith(' ')) cur!.body.push({ mark: 'ctx', text: t.slice(1) });
      else if (t.startsWith('-')) cur!.body.push({ mark: 'old', text: t.slice(1) });
      else if (t.startsWith('+')) cur!.body.push({ mark: 'new', text: t.slice(1) });
      else cur!.body.push({ mark: 'ctx', text: '' });
      i += 1;
      continue;
    }
    throw new Abort(`error: parse ${entry.no}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Abort(`error: parse ${s.lineNo}`);
  return { path: s.path, moveTo, chunks };
}

function v4aEdit(s: V4aSection, strict: boolean): EditFn {
  if (s.kind === 'add') {
    const made: string[] = [];
    for (const l of s.body) {
      if (l.text.startsWith('+')) made.push(l.text.slice(1));
      else if (l.text === '') made.push('');
      else throw new Abort(`error: parse ${l.no}`);
    }
    return (work) => {
      if (!isSafePath(s.path)) throw new EditError('unsafe', s.path);
      if (work.current(s.path) !== null) throw new EditError('exists', s.path);
      work.staged.set(s.path, made.length === 0 ? '' : made.join('\n') + '\n');
    };
  }
  if (s.kind === 'del') {
    if (s.body.length > 0) throw new Abort(`error: parse ${s.body[0]!.no}`);
    return (work) => {
      if (!isSafePath(s.path)) throw new EditError('unsafe', s.path);
      if (work.current(s.path) === null) throw new EditError('missing', s.path);
      work.staged.set(s.path, null);
    };
  }
  const upd = parseV4aUpdate(s);
  return (work) => {
    if (!isSafePath(upd.path)) throw new EditError('unsafe', upd.path);
    const before = work.current(upd.path);
    if (before === null) throw new EditError('missing', upd.path);
    if (upd.moveTo !== null) {
      if (!isSafePath(upd.moveTo)) throw new EditError('unsafe', upd.moveTo);
      if (work.current(upd.moveTo) !== null) throw new EditError('exists', upd.moveTo);
    }
    const doc = readDoc(before);
    let cursor = 0;
    for (const c of upd.chunks) {
      if (c.anchor !== null) {
        const found = findAtFirstTier(doc.lines, [c.anchor], strict, cursor);
        if (found === null) throw new EditError('no-match', upd.path);
        cursor = found.spots[0]! + 1;
      }
      const { oldLines, newLines } = splitOldNew(c.body);
      if (oldLines.length === 0) {
        const at = c.atEnd ? doc.lines.length : cursor;
        doc.lines.splice(at, 0, ...newLines.map((nl) => nl.text));
        cursor = at + newLines.length;
        continue;
      }
      const found = findAtFirstTier(doc.lines, oldLines, strict, cursor);
      if (found === null) throw new EditError('no-match', upd.path);
      const { tier } = found;
      let spots = found.spots;
      if (c.atEnd) spots = spots.filter((p) => p + oldLines.length === doc.lines.length);
      if (spots.length === 0) throw new EditError('no-match', upd.path);
      const pos = spots[0]!;
      const repl = buildReplacement(doc.lines, pos, oldLines, newLines, tier);
      doc.lines.splice(pos, oldLines.length, ...repl);
      cursor = pos + repl.length;
    }
    const out = writeDoc(doc);
    if (upd.moveTo !== null) {
      work.staged.set(upd.path, null);
      work.staged.set(upd.moveTo, out);
      work.relocations.push([upd.path, upd.moveTo]);
    } else {
      work.staged.set(upd.path, out);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Abort('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Abort(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!isBlank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Abort(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let cur: V4aSection | null = null;
  for (let k = first + 1; k < last; k++) {
    const l = lines[k]!;
    if (l.startsWith('*** Add File: ')) {
      cur = { kind: 'add', path: l.slice(13).trim(), lineNo: k + 1, body: [] };
      sections.push(cur);
    } else if (l.startsWith('*** Delete File: ')) {
      cur = { kind: 'del', path: l.slice(16).trim(), lineNo: k + 1, body: [] };
      sections.push(cur);
    } else if (l.startsWith('*** Update File: ')) {
      cur = { kind: 'upd', path: l.slice(16).trim(), lineNo: k + 1, body: [] };
      sections.push(cur);
    } else if (cur === null) {
      if (!isBlank(l)) throw new Abort(`error: parse ${k + 1}`);
    } else {
      cur.body.push({ text: l, no: k + 1 });
    }
  }
  if (sections.length === 0) throw new Abort('error: parse 1');
  for (const s of sections) {
    while (s.body.length > 0 && isBlank(s.body[s.body.length - 1]!.text)) s.body.pop();
  }
  return sections.map((s) => v4aEdit(s, strict));
}

// ---- Sections 1, 2, 10: command line, output, order and atomicity -------------

function runMain(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  const positional: string[] = [];
  let afterDashDash = false;
  for (const a of args) {
    if (!afterDashDash && a === '--') {
      afterDashDash = true;
      continue;
    }
    if (!afterDashDash && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && KNOWN_FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !checkOnly) checkOnly = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) return { code: 2, out: ['error: usage'] };
  const patchFile = positional.length === 0 || positional[0] === '-' ? null : positional[0]!;
  let text = '';
  try {
    text = readFileSync(patchFile ?? 0, 'utf8');
  } catch {
    if (patchFile !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: EditFn[];
  try {
    if (kind === 'json') edits = parseJsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Abort('error: parse 1');
  } catch (e) {
    if (e instanceof Abort) return { code: 2, out: [e.line] };
    throw e;
  }
  const work = new Work();
  const failures: EditError[] = [];
  for (const edit of edits) {
    const stagedBefore = new Map(work.staged);
    const movesBefore = work.relocations.length;
    try {
      edit(work);
    } catch (e) {
      if (!(e instanceof EditError)) throw e;
      work.staged.clear();
      for (const [k, v] of stagedBefore) work.staged.set(k, v);
      work.relocations.length = movesBefore;
      failures.push(e);
    }
  }
  if (failures.length > 0) {
    return { code: 1, out: [...failures.map((f) => `error: ${f.code} ${f.path}`), `failed: ${failures.length} of ${edits.length} edits`] };
  }
  const rows: Array<{ key: string; line: string }> = [];
  const newOfMove = new Set<string>();
  const oldOfMove = new Set<string>();
  for (const [oldP, newP] of work.relocations) {
    if (work.read(oldP) !== null && work.current(oldP) === null && work.read(newP) === null && work.current(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      newOfMove.add(newP);
      oldOfMove.add(oldP);
    }
  }
  for (const p of [...work.staged.keys()].sort(cmpUtf8)) {
    const was = work.read(p);
    const now = work.staged.get(p)!;
    if (was === now) continue;
    if (!newOfMove.has(p) && !oldOfMove.has(p)) {
      rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    }
    if (checkOnly) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  rows.sort((a, b) => cmpUtf8(a.key, b.key));
  const printed = rows.map((r) => r.line);
  return { code: 0, out: [...printed, `ok: ${printed.length} ${printed.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = runMain(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
