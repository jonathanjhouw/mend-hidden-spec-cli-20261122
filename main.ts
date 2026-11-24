// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
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
  readonly moves: [string, string][] = [];
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

type BodyKind = ' ' | '-' | '+';
interface BodyLine {
  kind: BodyKind;
  text: string;
  empty: boolean;
  noEol: boolean;
  rawBlank: boolean;
}
interface Hunk {
  a: number;
  body: BodyLine[];
}
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

const lead = (s: string): string => /^[ \t]*/.exec(s)![0];

/** Section 5: strip trailing spaces/tabs at tier 1, and leading too at tier 2. */
function tierKey(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function fileState(text: string): FileState {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text !== '' && text.endsWith(br);
  const lines = text === '' ? [] : text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function fileText(f: FileState): string {
  return f.lines.length === 0 ? '' : f.lines.join(f.br) + (f.final ? f.br : '');
}

function oldLines(body: BodyLine[]): BodyLine[] {
  return body.filter((b) => b.kind === ' ' || b.kind === '-');
}
function newLines(body: BodyLine[]): BodyLine[] {
  return body.filter((b) => b.kind === ' ' || b.kind === '+');
}

function occurrences(file: string[], o: BodyLine[], tier: number, from = 0): number[] {
  const found: number[] = [];
  if (o.length === 0) return found;
  for (let i = from; i + o.length <= file.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (tierKey(file[i + j]!, tier) !== tierKey(o[j]!.text, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) found.push(i);
  }
  return found;
}

function findTier(file: string[], o: BodyLine[], strict: boolean, from = 0, endOnly = false): { tier: number; positions: number[] } | null {
  for (let tier = 0; tier <= (strict ? 0 : 2); tier += 1) {
    let positions = occurrences(file, o, tier, from);
    if (endOnly) positions = positions.filter((p) => p + o.length === file.length);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

function reindent(text: string, f: string, p: string, tier: number): string {
  if (tier !== 2 || blank(text) || !text.startsWith(p)) return text;
  return f + text.slice(p.length);
}

/** Turn a body into replacement lines. Context lines are the file's own matched lines. */
function replace(body: BodyLine[], file: string[], pos: number, tier: number): { lines: string[]; lastNoEol: boolean } {
  const firstOld = body.find((b) => b.kind !== '+');
  const f = tier === 2 && pos < file.length ? lead(file[pos]!) : '';
  const p = tier === 2 && firstOld ? lead(firstOld.text) : '';
  const out: string[] = [];
  let fi = pos;
  let lastNoEol = false;
  for (const b of body) {
    if (b.kind === '-') {
      fi += 1;
      continue;
    }
    if (b.kind === ' ') {
      out.push(file[fi]!);
      fi += 1;
      lastNoEol = b.noEol;
    } else {
      out.push(reindent(b.text, f, p, tier));
      lastNoEol = b.noEol;
    }
  }
  return { lines: out, lastNoEol };
}

function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const w = fileState(text);
  let d = 0;
  for (const h of hunks) {
    const o = oldLines(h.body);
    const n = newLines(h.body);
    let pos: number;
    let tier = 0;
    if (o.length === 0) {
      pos = Math.max(0, Math.min(h.a + d, w.lines.length));
    } else {
      const found = findTier(w.lines, o, strict);
      if (found === null) throw new Fail('no-match', path);
      tier = found.tier;
      const target = h.a - 1 + d;
      pos = found.positions[0]!;
      for (const p of found.positions.slice(1)) {
        if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
      }
    }
    const atEnd = pos + o.length === w.lines.length;
    const r = replace(h.body, w.lines, pos, tier);
    w.lines.splice(pos, o.length, ...r.lines);
    if (atEnd) w.final = !r.lastNoEol;
    d += n.length - o.length;
  }
  return fileText(w);
}

function createdFromHunks(hunks: Hunk[]): string {
  const out: string[] = [];
  let noEol = false;
  for (const h of hunks) {
    for (const b of h.body) {
      if (b.kind === '+') {
        out.push(b.text);
        noEol = b.noEol;
      }
    }
  }
  return out.length === 0 ? '' : out.join('\n') + (noEol ? '' : '\n');
}

function diffPath(s: string): string | null {
  let p = s.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

interface DiffSection {
  old: string | null;
  new: string | null;
  pair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  creation: boolean;
  deletion: boolean;
  gitOld: string | null;
  gitNew: string | null;
  hunks: Hunk[];
  header: boolean;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: DiffSection[] = [];
  const add = (): DiffSection => {
    const s: DiffSection = {
      old: null, new: null, pair: false, renameFrom: null, renameTo: null,
      creation: false, deletion: false, gitOld: null, gitNew: null, hunks: [], header: true,
    };
    sections.push(s);
    return s;
  };
  let cur: DiffSection | null = null;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*?) b\/(.*)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = add();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      i += 1;
      continue;
    }
    if (l.startsWith('--- ')) {
      const next = lines[i + 1] ?? '';
      if (next.startsWith('+++ ')) {
        const op = diffPath(l.slice(4));
        const np = diffPath(next.slice(4));
        if (cur === null || !cur.header || cur.pair) cur = add();
        cur.pair = true;
        cur.old = op;
        cur.new = np;
        i += 2;
        continue;
      }
      if (cur !== null && cur.header) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      cur.header = false;
      const h: Hunk = { a: Number(m[1]!), body: [] };
      i += 1;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ') || (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) break;
        if (b.startsWith(' ')) {
          h.body.push({ kind: ' ', text: b.slice(1), empty: false, noEol: false, rawBlank: false });
        } else if (b.startsWith('-')) {
          h.body.push({ kind: '-', text: b.slice(1), empty: false, noEol: false, rawBlank: false });
        } else if (b.startsWith('+')) {
          h.body.push({ kind: '+', text: b.slice(1), empty: false, noEol: false, rawBlank: false });
        } else if (b.startsWith('\\')) {
          const prev = h.body[h.body.length - 1];
          if (prev !== undefined) prev.noEol = true;
        } else if (b === '') {
          h.body.push({ kind: ' ', text: '', empty: true, noEol: false, rawBlank: true });
        } else {
          break;
        }
        i += 1;
      }
      while (h.body.length > 0 && h.body[h.body.length - 1]!.empty) h.body.pop();
      cur.hunks.push(h);
      continue;
    }
    if (cur !== null && cur.header) {
      if (l.startsWith('rename from ')) cur.renameFrom = l.slice(12).trim();
      else if (l.startsWith('rename to ')) cur.renameTo = l.slice(10).trim();
      else if (l.startsWith('new file mode')) cur.creation = true;
      else if (l.startsWith('deleted file mode')) cur.deletion = true;
    }
    i += 1;
  }
  const edits: Edit[] = [];
  for (const s of sections) {
    const op = s.pair ? s.old : (s.renameFrom ?? s.gitOld);
    const np = s.pair ? s.new : (s.renameTo ?? s.gitNew);
    const names = [op, np].filter((p): p is string => p !== null);
    const guard = (): void => {
      for (const p of names) if (!safe(p)) throw new Fail('unsafe', p);
    };
    if (s.creation || op === null) {
      const p = np!;
      edits.push((tree) => {
        guard();
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, createdFromHunks(s.hunks));
      });
    } else if (s.deletion || np === null) {
      const p = op;
      edits.push((tree) => {
        guard();
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else if (op !== np) {
      const from = op;
      const to = np;
      edits.push((tree) => {
        guard();
        const before = tree.get(from);
        if (before === null) throw new Fail('missing', from);
        if (tree.get(to) !== null) throw new Fail('exists', to);
        tree.now.set(from, null);
        tree.now.set(to, applyHunks(before, s.hunks, strict, from));
        tree.moves.push([from, to]);
      });
    } else {
      const p = op;
      edits.push((tree) => {
        guard();
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        tree.now.set(p, applyHunks(before, s.hunks, strict, p));
      });
    }
  }
  return edits;
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const search = i;
    let path = prevPath;
    for (let j = i - 1; j >= prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l) || l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) throw new Exit2(`error: parse ${search + 1}`);
    let sep = -1;
    for (let j = search + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    let end = -1;
    if (sep >= 0) {
      for (let j = sep + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
      }
    }
    if (sep < 0 || end < 0) throw new Exit2(`error: parse ${search + 1}`);
    const o: BodyLine[] = lines.slice(search + 1, sep).map((text) => ({ kind: '-', text, empty: false, noEol: false, rawBlank: false }));
    const n: BodyLine[] = lines.slice(sep + 1, end).map((text) => ({ kind: '+', text, empty: false, noEol: false, rawBlank: false }));
    const body = [...o, ...n];
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (o.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const out = n.map((b) => b.text);
        tree.now.set(p, out.length === 0 ? '' : `${out.join('\n')}\n`);
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const w = fileState(before);
      const found = findTier(w.lines, o, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.positions.length !== 1) throw new Fail('ambiguous', p);
      const pos = found.positions[0]!;
      const r = replace(body, w.lines, pos, found.tier);
      w.lines.splice(pos, o.length, ...r.lines);
      tree.now.set(p, fileText(w));
    });
    prevEnd = end + 1;
    prevPath = p;
    i = end + 1;
  }
  return edits;
}

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}
type V4aSection =
  | { kind: 'add'; path: string; lines: string[]; at: number }
  | { kind: 'delete'; path: string; at: number }
  | { kind: 'update'; path: string; move: string | null; chunks: V4aChunk[]; at: number };

function findAnchor(file: string[], anchor: string, strict: boolean, from: number): number | null {
  for (let tier = 0; tier <= (strict ? 0 : 2); tier += 1) {
    for (let i = from; i < file.length; i += 1) {
      if (tierKey(file[i]!, tier) === tierKey(anchor, tier)) return i;
    }
  }
  return null;
}

function applyChunks(text: string, chunks: V4aChunk[], strict: boolean, path: string): string {
  const w = fileState(text);
  let cursor = 0;
  for (const c of chunks) {
    const o = oldLines(c.body);
    if (c.anchor !== null) {
      const at = findAnchor(w.lines, c.anchor, strict, cursor);
      if (at === null) throw new Fail('no-match', path);
      cursor = at + 1;
    }
    let pos: number;
    let tier = 0;
    if (o.length === 0) {
      pos = c.eof ? w.lines.length : Math.max(0, Math.min(cursor, w.lines.length));
    } else {
      const found = findTier(w.lines, o, strict, cursor, c.eof);
      if (found === null) throw new Fail('no-match', path);
      tier = found.tier;
      pos = found.positions[0]!;
    }
    const firstOld = c.body.find((b) => b.kind !== '+');
    const f = tier === 2 && o.length > 0 && pos < w.lines.length ? lead(w.lines[pos]!) : '';
    const p = tier === 2 && firstOld ? lead(firstOld.text) : '';
    const out: string[] = [];
    let fi = pos;
    for (const b of c.body) {
      if (b.kind === '-') {
        fi += 1;
      } else if (b.kind === ' ') {
        out.push(w.lines[fi]!);
        fi += 1;
      } else {
        out.push(reindent(b.text, f, p, tier));
      }
    }
    w.lines.splice(pos, o.length, ...out);
    cursor = pos + out.length;
  }
  return fileText(w);
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first < 0 ? 1 : first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSection = (s: string): boolean =>
    s.startsWith('*** Add File: ') || s.startsWith('*** Delete File: ') || s.startsWith('*** Update File: ');
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const at = i + 1;
      const path = l.slice(14).trim();
      const content: { text: string; raw: boolean }[] = [];
      i += 1;
      while (i < last && !isSection(lines[i]!)) {
        const b = lines[i]!;
        if (blank(b)) content.push({ text: '', raw: true });
        else if (b.startsWith('+')) content.push({ text: b.slice(1), raw: false });
        else throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      while (content.length > 0 && content[content.length - 1]!.raw) content.pop();
      sections.push({ kind: 'add', path, lines: content.map((c) => c.text), at });
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const at = i + 1;
      const path = l.slice(17).trim();
      i += 1;
      while (i < last && blank(lines[i]!)) i += 1;
      if (i < last && !isSection(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
      sections.push({ kind: 'delete', path, at });
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const at = i + 1;
      const path = l.slice(17).trim();
      i += 1;
      let move: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        move = lines[i]!.slice(13).trim();
        i += 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      while (i < last && !isSection(lines[i]!)) {
        const b = lines[i]!;
        if (b.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          cur = { anchor: b.slice(2).trim() || null, eof: false, body: [] };
        } else if (b.trim() === '*** End of File') {
          if (cur === null) cur = { anchor: null, eof: true, body: [] };
          else cur.eof = true;
          chunks.push(cur);
          cur = null;
        } else if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+')) {
          if (cur === null) cur = { anchor: null, eof: false, body: [] };
          const kind = b === '' ? ' ' : (b[0] as BodyKind);
          cur.body.push({ kind, text: b === '' ? '' : b.slice(1), empty: b === '', noEol: false, rawBlank: blank(b) });
        } else {
          throw new Exit2(`error: parse ${i + 1}`);
        }
        i += 1;
      }
      if (cur !== null) chunks.push(cur);
      for (const c of chunks) {
        while (c.body.length > 0 && c.body[c.body.length - 1]!.rawBlank) c.body.pop();
      }
      if (chunks.length === 0 && move === null) throw new Exit2(`error: parse ${at}`);
      sections.push({ kind: 'update', path, move, chunks, at });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  const edits: Edit[] = [];
  for (const s of sections) {
    const guard = (): void => {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (s.kind === 'update' && s.move !== null && !safe(s.move)) throw new Fail('unsafe', s.move);
    };
    if (s.kind === 'add') {
      const content = s.lines;
      edits.push((tree) => {
        guard();
        if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
        tree.now.set(s.path, content.length === 0 ? '' : `${content.join('\n')}\n`);
      });
    } else if (s.kind === 'delete') {
      edits.push((tree) => {
        guard();
        if (tree.get(s.path) === null) throw new Fail('missing', s.path);
        tree.now.set(s.path, null);
      });
    } else {
      const move = s.move;
      const chunks = s.chunks;
      edits.push((tree) => {
        guard();
        const before = tree.get(s.path);
        if (before === null) throw new Fail('missing', s.path);
        if (move !== null && tree.get(move) !== null) throw new Fail('exists', move);
        const after = applyChunks(before, chunks, strict, s.path);
        if (move !== null) {
          tree.now.set(s.path, null);
          tree.now.set(move, after);
          tree.moves.push([s.path, move]);
        } else {
          tree.now.set(s.path, after);
        }
      });
    }
  }
  return edits;
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
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict)
      : kind === 'search-replace' ? searchReplaceEdits(lines, strict)
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
  const moveFrom = new Map<string, string>();
  const moveTo = new Map<string, string>();
  for (const [from, to] of tree.moves) {
    if (tree.original(from) !== null && tree.get(from) === null && tree.original(to) === null && tree.get(to) !== null) {
      moveFrom.set(from, to);
      moveTo.set(to, from);
    }
  }
  const rows: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const from = moveTo.get(p);
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    const renamed = moveFrom.has(p);
    if (!renamed && from === undefined && was === now) continue;
    if (!renamed) rows.push(from !== undefined ? `R ${from} -> ${p}` : `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
