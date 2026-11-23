// main.ts is mend, the CLI SPEC.md specifies (MIT). The command line, the output and exit codes, safe paths,
// format detection, JSON edits and the all-or-nothing write are the kit's starting point (sections 1 to 4, 9
// and 10). The three remaining formats are implemented below the starter's JSON reader: matching lines at
// three tiers (section 5), unified diffs (section 6), SEARCH/REPLACE blocks (section 7) and V4A patches
// (section 8), plus the R lines section 2 wants for moves. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Sections 5 to 8, written for this entry: the three-tier line matcher, and
// the readers for unified diffs, SEARCH/REPLACE blocks and V4A patches.
// ---------------------------------------------------------------------------

/** Moves that succeeded, as [old path, new path], for the R lines of section 2. */
const moveLog: Array<[string, string]> = [];

const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

/** A line as a tier sees it (section 5): tier 0 exact, 1 trailing-trimmed, 2 fully trimmed. */
function tierKey(s: string, tier: number): string {
  return tier === 0 ? s : tier === 1 ? trimTrail(s) : trimBoth(s);
}

interface Found {
  tier: number;
  positions: number[];
}

/**
 * Every occurrence of `old` in `lines` at or after `from`, at the first tier
 * that has one (section 5). Occurrences may overlap. Null when no tier has one.
 */
function findLines(lines: string[], old: string[], strict: boolean, from: number): Found | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const want = old.map((l) => tierKey(l, tier));
    const positions: number[] = [];
    for (let i = Math.max(0, from); i + old.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < old.length; j++) {
        if (tierKey(lines[i + j]!, tier) !== want[j]) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** Section 5's tier-2 re-indentation of one new line: swap old's indent P for the file's F. */
function reindent(line: string, F: string, P: string): string {
  if (line === '' || /^[ \t]+$/.test(line)) return line;
  return line.startsWith(P) ? F + line.slice(P.length) : line;
}

/** A file as section 3 sees it: its lines, its own line break, and whether it ends with one. */
interface FileParts {
  lines: string[];
  br: string;
  fin: boolean;
}

function splitText(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let fin = false;
  if (text.endsWith(br)) {
    parts.pop();
    fin = true;
  }
  return { lines: parts, br, fin };
}

function joinText(p: FileParts): string {
  return p.lines.length === 0 ? '' : p.lines.join(p.br) + (p.fin ? p.br : '');
}

/** One body line of a unified hunk or a V4A chunk: context, old or new, plus its no-newline mark. */
interface BodyLine {
  kind: string;
  text: string;
  noEol: boolean;
}

/**
 * Splice a matched body over lines[pos .. pos+oldLen): context lines are
 * written as the file's own matched lines, new lines as the patch's (with
 * tier-2 re-indentation), old lines dropped. Returns how many lines were written.
 */
function spliceMatch(lines: string[], pos: number, oldLen: number, body: BodyLine[], tier: number, oldFirst: string): number {
  const F = leadWs(lines[pos]!);
  const P = leadWs(oldFirst);
  const out: string[] = [];
  let oi = 0;
  for (const b of body) {
    if (b.kind === ' ') {
      out.push(lines[pos + oi]!);
      oi++;
    } else if (b.kind === '-') {
      oi++;
    } else {
      out.push(tier === 2 ? reindent(b.text, F, P) : b.text);
    }
  }
  lines.splice(pos, oldLen, ...out);
  return out.length;
}

/** Splice plain new lines (SEARCH/REPLACE has no context lines) over a match. */
function splicePlain(lines: string[], pos: number, oldLines: string[], newLines: string[], tier: number): void {
  const F = leadWs(lines[pos]!);
  const P = leadWs(oldLines[0]!);
  lines.splice(pos, oldLines.length, ...newLines.map((l) => (tier === 2 ? reindent(l, F, P) : l)));
}

// --- Section 6: unified diffs ----------------------------------------------

interface UHunk {
  a: number;
  body: BodyLine[];
}

interface USection {
  diffOld?: string;
  diffNew?: string;
  oldP?: string | null;
  newP?: string | null;
  renFrom?: string;
  renTo?: string;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
}

/** The path a --- or +++ line names: up to the first tab, spaces removed, /dev/null is no file. */
function headerPath(raw: string): string | null {
  const p = raw.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** A hunk's body: the lines after its header, with \ marks folded onto the line before them. */
function readBody(lines: string[], i: number): { body: BodyLine[]; next: number } {
  const body: BodyLine[] = [];
  const fromEmpty: boolean[] = [];
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith('\\')) {
      if (body.length > 0) body[body.length - 1]!.noEol = true;
      i++;
      continue;
    }
    if (l === '') {
      body.push({ kind: ' ', text: '', noEol: false });
      fromEmpty.push(true);
      i++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ' || c === '-' || c === '+') {
      body.push({ kind: c, text: l.slice(1), noEol: false });
      fromEmpty.push(false);
      i++;
      continue;
    }
    break;
  }
  // Empty lines at the end of a body are not part of it.
  while (body.length > 0) {
    const last = body[body.length - 1]!;
    if (fromEmpty[fromEmpty.length - 1] && !last.noEol && last.kind === ' ') {
      body.pop();
      fromEmpty.pop();
    } else break;
  }
  return { body, next: i };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  const fresh = (): USection => ({ newFile: false, delFile: false, hunks: [] });
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      sections.push(cur);
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.hunks.length > 0 || cur.oldP !== undefined) {
        cur = fresh();
        sections.push(cur);
      }
      cur.oldP = headerPath(l.slice(4));
      cur.newP = headerPath(lines[i + 1]!.slice(4));
      i += 2;
      continue;
    }
    if (l.startsWith('--- ') && cur !== null && cur.hunks.length === 0) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (!m || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const { body, next } = readBody(lines, i + 1);
      cur.hunks.push({ a: Number(m[1]), body });
      i = next;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (l.startsWith('rename from ')) cur.renFrom = l.slice(12).trim();
      else if (l.startsWith('rename to ')) cur.renTo = l.slice(10).trim();
      else if (l.startsWith('new file mode')) cur.newFile = true;
      else if (l.startsWith('deleted file mode')) cur.delFile = true;
    }
    i++;
  }
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

function unifiedSectionEdit(sec: USection, strict: boolean): Edit {
  const oldPath = sec.oldP !== undefined ? sec.oldP : sec.renFrom !== undefined ? sec.renFrom : sec.diffOld ?? null;
  const newPath = sec.newP !== undefined ? sec.newP : sec.renTo !== undefined ? sec.renTo : sec.diffNew ?? null;
  return (tree) => {
    if (oldPath === null || sec.newFile) {
      // A creation: the new path is free, and the file is the hunks' + lines.
      const target = newPath;
      if (target === null) return;
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const out: string[] = [];
      let lastAdd: BodyLine | null = null;
      for (const h of sec.hunks) {
        for (const b of h.body) {
          if (b.kind === '+') {
            out.push(b.text);
            lastAdd = b;
          }
        }
      }
      const fin = !(lastAdd !== null && lastAdd.noEol);
      tree.now.set(target, out.length === 0 ? '' : out.join('\n') + (fin ? '\n' : ''));
      return;
    }
    if (newPath === null || sec.delFile) {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    const from = oldPath;
    const to = newPath;
    if (!safe(from)) throw new Fail('unsafe', from);
    if (to !== from && !safe(to)) throw new Fail('unsafe', to);
    const before = tree.get(from);
    if (before === null) throw new Fail('missing', from);
    if (to !== from && tree.get(to) !== null) throw new Fail('exists', to);
    const parts = splitText(before);
    let d = 0;
    for (const h of sec.hunks) {
      const old = h.body.filter((b) => b.kind !== '+').map((b) => b.text);
      const nLen = h.body.filter((b) => b.kind !== '-').length;
      if (old.length === 0) {
        const ins = h.body.filter((b) => b.kind === '+');
        const at = Math.max(0, Math.min(h.a + d, parts.lines.length));
        const atEnd = at === parts.lines.length;
        parts.lines.splice(at, 0, ...ins.map((b) => b.text));
        if (atEnd && ins.length > 0) parts.fin = !ins[ins.length - 1]!.noEol;
        d += ins.length;
      } else {
        const found = findLines(parts.lines, old, strict, 0);
        if (found === null) throw new Fail('no-match', from);
        // The occurrence whose position is nearest to A - 1 + d; the earlier of two equally near.
        const targetPos = h.a - 1 + d;
        let pos = found.positions[0]!;
        for (const p of found.positions) {
          if (Math.abs(p - targetPos) < Math.abs(pos - targetPos)) pos = p;
        }
        const ranToEnd = pos + old.length === parts.lines.length;
        spliceMatch(parts.lines, pos, old.length, h.body, found.tier, old[0]!);
        if (ranToEnd) {
          let lastCtxAdd: BodyLine | null = null;
          for (const b of h.body) if (b.kind !== '-') lastCtxAdd = b;
          parts.fin = !(lastCtxAdd !== null && lastCtxAdd.noEol);
        }
        d += nLen - old.length;
      }
    }
    const text = joinText(parts);
    if (to !== from) {
      tree.now.set(to, text);
      tree.now.set(from, null);
      moveLog.push([from, to]);
    } else {
      tree.now.set(from, text);
    }
  };
}

// --- Section 7: SEARCH/REPLACE blocks ---------------------------------------

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const at = i;
    // The path is the nearest usable line before the block, after the previous one.
    let path: string | null = null;
    for (let j = at - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${at + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = at + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${at + 1}`);
    let gt = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        gt = j;
        break;
      }
    }
    if (gt < 0) throw new Exit2(`error: parse ${at + 1}`);
    edits.push(srBlockEdit(path, lines.slice(at + 1, eq), lines.slice(eq + 1, gt), strict));
    prevPath = path;
    prevEnd = gt + 1;
    i = gt + 1;
  }
  return edits;
}

function srBlockEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const parts = splitText(before);
    const found = findLines(parts.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    splicePlain(parts.lines, found.positions[0]!, oldLines, newLines, found.tier);
    tree.now.set(path, joinText(parts));
  };
}

// --- Section 8: V4A patches --------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  line: number;
  addLines: string[];
  moveTo?: string;
  chunks: VChunk[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j--) {
    if (!blank(lines[j])) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const secStart = (l: string): { kind: VSection['kind']; path: string } | null => {
    if (l.startsWith('*** Add File:')) return { kind: 'add', path: l.slice('*** Add File:'.length).trim() };
    if (l.startsWith('*** Delete File:')) return { kind: 'delete', path: l.slice('*** Delete File:'.length).trim() };
    if (l.startsWith('*** Update File:')) return { kind: 'update', path: l.slice('*** Update File:'.length).trim() };
    return null;
  };
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    const st = secStart(l);
    if (st === null) throw new Exit2(`error: parse ${i + 1}`);
    const secLine = i;
    i++;
    if (st.kind === 'add') {
      const content: string[] = [];
      while (i < last) {
        const bl = lines[i]!;
        if (secStart(bl) !== null) break;
        if (bl.startsWith('+')) {
          content.push(bl.slice(1));
          i++;
          continue;
        }
        if (bl === '') {
          content.push('');
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      // Blank lines at the end of a section are not part of it.
      while (content.length > 0 && content[content.length - 1] === '') content.pop();
      sections.push({ kind: 'add', path: st.path, line: secLine, addLines: content, chunks: [] });
    } else if (st.kind === 'delete') {
      while (i < last) {
        const bl = lines[i]!;
        if (secStart(bl) !== null) break;
        if (blank(bl)) {
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      sections.push({ kind: 'delete', path: st.path, line: secLine, addLines: [], chunks: [] });
    } else {
      const raw: Array<{ text: string; at: number }> = [];
      while (i < last) {
        const bl = lines[i]!;
        if (secStart(bl) !== null) break;
        raw.push({ text: bl, at: i });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      sections.push(parseUpdate(st.path, secLine, raw));
    }
  }
  return sections.map((s) => v4aSectionEdit(s, strict));
}

/** The inside of an Update File section: an optional Move to, then the chunks. */
function parseUpdate(path: string, secLine: number, raw: Array<{ text: string; at: number }>): VSection {
  let moveTo: string | undefined;
  let idx = 0;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to:')) {
    moveTo = raw[0]!.text.slice('*** Move to:'.length).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  for (; idx < raw.length; idx++) {
    const { text: l, at } = raw[idx]!;
    if (l.startsWith('@@')) {
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      chunks.push(cur);
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${at + 1}`);
      cur.eof = true;
      cur = null;
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        cur = { anchor: null, eof: false, body: [] };
        chunks.push(cur);
      }
      cur.body.push({ kind: l === '' ? ' ' : l[0]!, text: l === '' ? '' : l.slice(1), noEol: false });
      continue;
    }
    throw new Exit2(`error: parse ${at + 1}`);
  }
  if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${secLine + 1}`);
  return { kind: 'update', path, line: secLine, addLines: [], moveTo, chunks };
}

function v4aSectionEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    const path = sec.path;
    if (!safe(path)) throw new Fail('unsafe', path);
    if (sec.kind === 'add') {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
      return;
    }
    if (sec.moveTo !== undefined && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (sec.moveTo !== undefined && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const parts = splitText(before);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        const hit = findLines(parts.lines, [chunk.anchor], strict, cursor);
        if (hit === null) throw new Fail('no-match', path);
        cursor = hit.positions[0]! + 1;
      }
      const old = chunk.body.filter((b) => b.kind !== '+').map((b) => b.text);
      if (old.length === 0) {
        const ins = chunk.body.filter((b) => b.kind === '+').map((b) => b.text);
        const at = chunk.eof ? parts.lines.length : Math.min(cursor, parts.lines.length);
        parts.lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
        continue;
      }
      // The first occurrence at or after the cursor, at the first tier with one;
      // an end-of-file chunk takes only an occurrence that ends at the last line.
      let placed: { tier: number; pos: number } | null = null;
      for (const tier of strict ? [0] : [0, 1, 2]) {
        const want = old.map((x) => tierKey(x, tier));
        for (let p = cursor; p + old.length <= parts.lines.length; p++) {
          if (chunk.eof && p + old.length !== parts.lines.length) continue;
          let ok = true;
          for (let j = 0; j < old.length; j++) {
            if (tierKey(parts.lines[p + j]!, tier) !== want[j]) {
              ok = false;
              break;
            }
          }
          if (ok) {
            placed = { tier, pos: p };
            break;
          }
        }
        if (placed !== null) break;
      }
      if (placed === null) throw new Fail('no-match', path);
      const written = spliceMatch(parts.lines, placed.pos, old.length, chunk.body, placed.tier, old[0]!);
      cursor = placed.pos + written;
    }
    const text = joinText(parts);
    if (sec.moveTo !== undefined) {
      tree.now.set(sec.moveTo, text);
      tree.now.set(path, null);
      moveLog.push([path, sec.moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Section 2's change lines: A, D or M per changed path, except that a move
  // whose old path is gone and whose new path is new prints one R line, sorted
  // by the new path, in place of that pair's D and A lines.
  const kinds = new Map<string, string>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    kinds.set(p, was === null ? 'A' : now === null ? 'D' : 'M');
  }
  const used = new Set<string>();
  const rows: Array<{ key: string; text: string }> = [];
  for (const [o, n] of moveLog) {
    if (kinds.get(o) === 'D' && kinds.get(n) === 'A' && !used.has(o) && !used.has(n)) {
      rows.push({ key: n, text: `R ${o} -> ${n}` });
      used.add(o);
      used.add(n);
    }
  }
  for (const [p, k] of kinds) {
    if (!used.has(p)) rows.push({ key: p, text: `${k} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const texts = rows.map((r) => r.text);
  return { code: 0, out: [...texts, `ok: ${texts.length} ${texts.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
