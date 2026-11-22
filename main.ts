// mend: one patch tool for every AI edit format (SPEC.md, hidden-spec-cli-01).
// Node 22, standard library only. Run as `node main.ts [options] [PATCH]`.
//
// A patch is read in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON text-editor calls), detected or named, and applied to the tree of
// text files in the working directory: every file changes or nothing does.
// Exit 0 lists what changed; exit 1 lists the edits that failed; exit 2 is a
// usage, missing-patch, format or parse error, one line on stdout.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** An exit-2 error: the single line it prints. */
class UsageFault extends Error {
  readonly line: string;
  constructor(line: string) {
    super(line);
    this.line = line;
  }
}

/** One edit that failed: its code and the path the failure concerns. */
class EditFault extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const FORMATS: string[] = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with /, holds no \, and none of its segments is empty, . or .. */
function isSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const byteLess = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/** One file's lines, its line break, and whether it ends with one. */
interface FileText {
  lines: string[];
  br: string;
  final: boolean;
}

function readFileText(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const first = text.indexOf('\n');
  const br = first > 0 && text[first - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function writeFileText(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted). */
class Tree {
  private readonly disk = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ old: string; nw: string }> = [];

  onDisk(p: string): string | null {
    if (!this.disk.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.disk.set(p, v);
    }
    return this.disk.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.onDisk(p);
  }
}

type Edit = (tree: Tree) => void;

// ---- section 5: matching lines ----

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function linesEqual(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Every 0-based position where O occurs in the file's lines at this tier. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!linesEqual(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2; only 0 when strict) where O occurs at or after `from`, with its positions. */
function matchAt(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t).filter((p) => p >= from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: its text, and for a context line the index of its line in O. */
interface NewLine {
  text: string;
  ctx: number | null;
}

/** The lines that replace a match: context lines are the file's own matched lines;
    at tier 2 every other line is re-indented from O's first line to the file's. */
function replacementLines(n: NewLine[], file: string[], pos: number, tier: number, oFirst: string): string[] {
  const out: string[] = [];
  const f = tier === 2 ? leadWs(file[pos]!) : '';
  const p = tier === 2 ? leadWs(oFirst) : '';
  for (const e of n) {
    if (e.ctx !== null) {
      out.push(file[pos + e.ctx]!);
      continue;
    }
    if (tier === 2 && e.text !== '' && e.text.trim() !== '' && e.text.startsWith(p)) {
      out.push(f + e.text.slice(p.length));
    } else {
      out.push(e.text);
    }
  }
  return out;
}

// ---- section 6: unified diffs ----

interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

const hunkHead = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const gitHead = /^diff --git a\/(\S+) b\/(\S+)$/;

/** A ---/+++ path: after the four characters, up to the first tab, spaces removed, a/ or b/ removed, /dev/null is no file. */
function headerPath(line: string): string | null {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function isBodyLine(l: string): boolean {
  return l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\');
}

function toBodyLine(l: string): BodyLine {
  if (l === '') return { kind: ' ', text: '' };
  const k = l[0] as ' ' | '-' | '+' | '\\';
  return { kind: k, text: l.slice(1) };
}

/** O is the context and - lines, N the context and + lines, in body order. */
function chunkSeqs(body: BodyLine[]): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      const idx = o.length;
      o.push(b.text);
      n.push({ text: b.text, ctx: idx });
    } else if (b.kind === '-') {
      o.push(b.text);
    } else if (b.kind === '+') {
      n.push({ text: b.text, ctx: null });
    }
  }
  return { o, n };
}

/** Whether a \ line follows the chunk's last context or + line. */
function chunkNoBreak(body: BodyLine[]): boolean {
  for (let i = body.length - 1; i >= 0; i--) {
    const b = body[i]!;
    if (b.kind === ' ' || b.kind === '+') {
      return body[i + 1] !== undefined && body[i + 1]!.kind === '\\';
    }
  }
  return false;
}

/** Apply a section's hunks to a file's text, in order. Throws EditFault no-match. */
function applyHunks(before: string, hunks: Hunk[], strict: boolean, failPath: string): string {
  const f = readFileText(before);
  let d = 0;
  for (const h of hunks) {
    const { o, n } = chunkSeqs(h.body);
    if (o.length === 0) {
      let at = h.a + d;
      if (at < 0) at = 0;
      if (at > f.lines.length) at = f.lines.length;
      const wasEnd = at === f.lines.length;
      const added = n.map((e) => e.text);
      f.lines.splice(at, 0, ...added);
      if (wasEnd) f.final = !chunkNoBreak(h.body);
    } else {
      const m = matchAt(f.lines, o, strict);
      if (m === null) throw new EditFault('no-match', failPath);
      const target = h.a - 1 + d;
      let best = m.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of m.occ) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const pos = best;
      const rep = replacementLines(n, f.lines, pos, m.tier, o[0]!);
      const runsEnd = pos + o.length === f.lines.length;
      f.lines.splice(pos, o.length, ...rep);
      if (runsEnd) f.final = !chunkNoBreak(h.body);
    }
    d += n.length - o.length;
  }
  return writeFileText(f);
}

interface UniWork {
  hasPair: boolean;
  pairOld: string | null;
  pairNew: string | null;
  renOld: string | null;
  renNew: string | null;
  gitOld: string | null;
  gitNew: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
  phase: 'header' | 'hunks';
}

function blankUniWork(): UniWork {
  return {
    hasPair: false,
    pairOld: null,
    pairNew: null,
    renOld: null,
    renNew: null,
    gitOld: null,
    gitNew: null,
    newFile: false,
    delFile: false,
    hunks: [],
    phase: 'header',
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniWork[] = [];
  let cur: UniWork | null = null;
  let hunk: Hunk | null = null;

  const finishHunk = (): void => {
    if (hunk === null) return;
    while (hunk.body.length > 0) {
      const last = hunk.body[hunk.body.length - 1]!;
      if (last.kind === ' ' && last.text === '') hunk.body.pop();
      else break;
    }
    cur!.hunks.push(hunk);
    hunk = null;
  };
  const finishSection = (): void => {
    finishHunk();
    if (cur !== null) sections.push(cur);
    cur = null;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (hunk !== null) {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        finishHunk();
        // fall through: the --- line starts a new section below
      } else if (isBodyLine(line)) {
        hunk.body.push(toBodyLine(line));
        i++;
        continue;
      } else {
        finishHunk();
        // fall through: process this line outside a body
      }
    }
    if (line.startsWith('diff --git ')) {
      const m = gitHead.exec(line);
      if (m === null) throw new UsageFault(`error: parse ${i + 1}`);
      finishSection();
      cur = blankUniWork();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.phase === 'header' && !cur.hasPair) {
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(lines[i + 1]!);
        cur.hasPair = true;
        i += 2;
        continue;
      }
      finishSection();
      cur = blankUniWork();
      cur.pairOld = headerPath(line);
      cur.pairNew = headerPath(lines[i + 1]!);
      cur.hasPair = true;
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && cur.phase === 'header') throw new UsageFault(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = hunkHead.exec(line);
      if (m === null) throw new UsageFault(`error: parse ${i + 1}`);
      if (cur === null) throw new UsageFault(`error: parse ${i + 1}`);
      cur.phase = 'hunks';
      hunk = { a: parseInt(m[1]!, 10), body: [] };
      i++;
      continue;
    }
    if (cur !== null && cur.phase === 'header') {
      if (line.startsWith('rename from ')) cur.renOld = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renNew = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
    }
    i++;
  }
  finishSection();
  return sections.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(s: UniWork, strict: boolean): Edit {
  const oldPath = s.pairOld ?? s.renOld ?? s.gitOld;
  const newPath = s.pairNew ?? s.renNew ?? s.gitNew;
  const oldNull = oldPath === null;
  const newNull = newPath === null;
  if ((oldNull || s.newFile) && !newNull) {
    const np = newPath!;
    return (tree) => {
      if (!isSafe(np)) throw new EditFault('unsafe', np);
      if (tree.get(np) !== null) throw new EditFault('exists', np);
      let lastPlus: { h: Hunk; idx: number } | null = null;
      const plus: string[] = [];
      for (const h of s.hunks) {
        h.body.forEach((b, idx) => {
          if (b.kind === '+') {
            plus.push(b.text);
            lastPlus = { h, idx };
          }
        });
      }
      const noBreak =
        lastPlus !== null &&
        lastPlus.h.body[lastPlus.idx + 1] !== undefined &&
        lastPlus.h.body[lastPlus.idx + 1]!.kind === '\\';
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (noBreak ? '' : '\n'));
    };
  }
  if ((newNull || s.delFile) && !oldNull) {
    const op = oldPath!;
    return (tree) => {
      if (!isSafe(op)) throw new EditFault('unsafe', op);
      if (tree.get(op) === null) throw new EditFault('missing', op);
      tree.now.set(op, null);
    };
  }
  if (!oldNull && !newNull && oldPath !== newPath) {
    const op = oldPath!;
    const np = newPath!;
    return (tree) => {
      if (!isSafe(op)) throw new EditFault('unsafe', op);
      if (!isSafe(np)) throw new EditFault('unsafe', np);
      const before = tree.get(op);
      if (before === null) throw new EditFault('missing', op);
      if (tree.get(np) !== null) throw new EditFault('exists', np);
      const result = applyHunks(before, s.hunks, strict, op);
      tree.now.set(np, result);
      tree.now.set(op, null);
      tree.moves.push({ old: op, nw: np });
    };
  }
  if (!oldNull && !newNull) {
    const p = oldPath!;
    return (tree) => {
      if (!isSafe(p)) throw new EditFault('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFault('missing', p);
      tree.now.set(p, applyHunks(before, s.hunks, strict, p));
    };
  }
  return () => {};
}

// ---- section 7: SEARCH/REPLACE blocks ----

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchAt = i;
    let path: string | null = null;
    for (let j = searchAt - 1; j > prevEnd; j--) {
      const t = lines[j]!;
      if (isBlank(t)) continue;
      const tr = t.trim();
      if (tr.startsWith('```')) continue;
      path = tr;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new UsageFault(`error: parse ${searchAt + 1}`);
    let eq = -1;
    for (let j = searchAt + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new UsageFault(`error: parse ${searchAt + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new UsageFault(`error: parse ${searchAt + 1}`);
    const oldLines = lines.slice(searchAt + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevEnd = rep;
    prevPath = path;
    i = rep + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!isSafe(path)) throw new EditFault('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new EditFault('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new EditFault('missing', path);
    const f = readFileText(before);
    const m = matchAt(f.lines, oldLines, strict);
    if (m === null) throw new EditFault('no-match', path);
    if (m.occ.length > 1) throw new EditFault('ambiguous', path);
    const pos = m.occ[0]!;
    const n: NewLine[] = newLines.map((t) => ({ text: t, ctx: null }));
    const rep = replacementLines(n, f.lines, pos, m.tier, oldLines[0]!);
    f.lines.splice(pos, oldLines.length, ...rep);
    tree.now.set(path, writeFileText(f));
  };
}

// ---- section 8: V4A patches ----

interface VChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new UsageFault('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new UsageFault(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isBlank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new UsageFault(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice(14).trim();
      i++;
      const sec: string[] = [];
      while (i < last && !isSectionStart(lines[i]!)) {
        const l = lines[i]!;
        if (l.startsWith('+')) sec.push(l.slice(1));
        else if (l === '') sec.push('');
        else throw new UsageFault(`error: parse ${i + 1}`);
        i++;
      }
      while (sec.length > 0 && sec[sec.length - 1] === '') sec.pop();
      edits.push(vAddEdit(path, sec));
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice(17).trim();
      i++;
      while (i < last && !isSectionStart(lines[i]!)) {
        if (!isBlank(lines[i]!)) throw new UsageFault(`error: parse ${i + 1}`);
        i++;
      }
      edits.push(vDeleteEdit(path));
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice(17).trim();
      const updateLine = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice(13).trim();
        i++;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let seenChunk = false;
      const close = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      while (i < last && !isSectionStart(lines[i]!)) {
        const l = lines[i]!;
        if (l.startsWith('@@')) {
          close();
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          seenChunk = true;
          i++;
          continue;
        }
        if (l.trimEnd() === '*** End of File') {
          if (cur === null) throw new UsageFault(`error: parse ${i + 1}`);
          cur.eof = true;
          close();
          i++;
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) {
            if (seenChunk) {
              if (isBlank(l)) {
                i++;
                continue;
              }
              throw new UsageFault(`error: parse ${i + 1}`);
            }
            cur = { anchor: null, body: [], eof: false };
            seenChunk = true;
          }
          cur.body.push(toBodyLine(l));
          i++;
          continue;
        }
        throw new UsageFault(`error: parse ${i + 1}`);
      }
      close();
      // Blank lines at the end of a section are not part of it: drop the trailing
      // empty context lines of the last chunk, unless that chunk was closed by
      // *** End of File (its blanks before that line are chunk content).
      if (chunks.length > 0) {
        const lc = chunks[chunks.length - 1]!;
        if (!lc.eof) {
          while (lc.body.length > 0) {
            const b = lc.body[lc.body.length - 1]!;
            if (b.kind === ' ' && b.text === '') lc.body.pop();
            else break;
          }
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new UsageFault(`error: parse ${updateLine}`);
      edits.push(vUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new UsageFault(`error: parse ${i + 1}`);
  }
  return edits;
}

function vAddEdit(path: string, secLines: string[]): Edit {
  return (tree) => {
    if (!isSafe(path)) throw new EditFault('unsafe', path);
    if (tree.get(path) !== null) throw new EditFault('exists', path);
    tree.now.set(path, secLines.length === 0 ? '' : secLines.join('\n') + '\n');
  };
}

function vDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!isSafe(path)) throw new EditFault('unsafe', path);
    if (tree.get(path) === null) throw new EditFault('missing', path);
    tree.now.set(path, null);
  };
}

function vUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!isSafe(path)) throw new EditFault('unsafe', path);
    if (moveTo !== null && !isSafe(moveTo)) throw new EditFault('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new EditFault('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new EditFault('exists', moveTo);
    const f = readFileText(before);
    let cursor = 0;
    for (const ch of chunks) {
      const { o, n } = chunkSeqs(ch.body);
      if (ch.anchor !== null) {
        const m = matchAt(f.lines, [ch.anchor], strict, cursor);
        if (m === null) throw new EditFault('no-match', path);
        cursor = m.occ[0]! + 1;
      }
      if (o.length === 0) {
        const at = ch.eof ? f.lines.length : cursor;
        const added = n.map((e) => e.text);
        f.lines.splice(at, 0, ...added);
        cursor = at + added.length;
      } else {
        const m = matchAt(f.lines, o, strict, cursor);
        if (m === null) throw new EditFault('no-match', path);
        let pos = m.occ[0]!;
        if (ch.eof) {
          const ends = m.occ.filter((p) => p + o.length === f.lines.length);
          if (ends.length === 0) throw new EditFault('no-match', path);
          pos = ends[0]!;
        }
        const rep = replacementLines(n, f.lines, pos, m.tier, o[0]!);
        f.lines.splice(pos, o.length, ...rep);
        cursor = pos + rep.length;
      }
    }
    const result = writeFileText(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, result);
      tree.now.set(path, null);
      tree.moves.push({ old: path, nw: moveTo });
    } else {
      tree.now.set(path, result);
    }
  };
}

// ---- section 9: JSON edits ----

/** One JSON edit object, or null when it is not one. */
function jsonEditObject(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const existing = (tree: Tree): string => {
    if (!isSafe(p)) throw new EditFault('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new EditFault('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!isSafe(p)) throw new EditFault('unsafe', p);
      if (tree.get(p) !== null) throw new EditFault('exists', p);
      tree.now.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = existing(tree);
      const crlf = readFileText(before).br === '\r\n';
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = norm(before);
      const old = norm(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count++;
      if (count === 0) throw new EditFault('no-match', p);
      if (count > 1) throw new EditFault('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + norm(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const lineNo = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = existing(tree);
      const f = readFileText(before);
      if (lineNo < 0 || lineNo > f.lines.length) throw new EditFault('no-match', p);
      f.lines.splice(lineNo, 0, ...add);
      tree.now.set(p, writeFileText(f));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new UsageFault('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new UsageFault(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new UsageFault(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEditObject(x);
      if (e === null) throw new UsageFault(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, idx) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEditObject(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new UsageFault(`error: parse ${idx + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- section 4: detecting the format ----

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, idx) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[idx + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

// ---- sections 1, 2 and 10: invocation, output, order and atomicity ----

function runCli(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) {
        format = a.slice(9);
      } else if (a === '--check' && !check) {
        check = true;
      } else if (a === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const patchArg = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(patchArg ?? 0, 'utf8');
  } catch {
    if (patchArg !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new UsageFault('error: parse 1');
  } catch (e) {
    if (e instanceof UsageFault) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: EditFault[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFault)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  const rows: Array<{ key: string; line: string }> = [];
  const usedDel = new Set<string>();
  const usedAdd = new Set<string>();
  for (const mv of tree.moves) {
    if (
      tree.onDisk(mv.old) !== null &&
      tree.get(mv.old) === null &&
      tree.onDisk(mv.nw) === null &&
      tree.get(mv.nw) !== null
    ) {
      rows.push({ key: mv.nw, line: `R ${mv.old} -> ${mv.nw}` });
      usedDel.add(mv.old);
      usedAdd.add(mv.nw);
    }
  }
  const changed: string[] = [];
  for (const p of [...tree.now.keys()].sort(byteLess)) {
    const was = tree.onDisk(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push(p);
    const k = was === null ? 'A' : now === null ? 'D' : 'M';
    if (k === 'D' && usedDel.has(p)) continue;
    if (k === 'A' && usedAdd.has(p)) continue;
    rows.push({ key: p, line: `${k} ${p}` });
  }
  rows.sort((a, b) => byteLess(a.key, b.key));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = runCli(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
