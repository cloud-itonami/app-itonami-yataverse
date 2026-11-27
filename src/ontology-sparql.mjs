// Bounded, read-only, basis-pinned SPARQL parser, EDN/JSON algebra bridge, and evaluator
// over rdf.core-shaped quads from an OntologySnapshot.
//
// Aligns with kotoba/lib/kotoba.sparql/src/sparql/core.cljk:
// - Algebra ops: :bgp, :filter, :join, :union, :optional, :group, :project, :distinct, :order-by, :slice
// - Query forms: SELECT, ASK, CONSTRUCT, DESCRIBE
// - Linear-time Thompson NFA REGEX evaluator (zero backtracking ReDoS)
// - Strict fail-closed refusals: remote SERVICE, FROM/FROM NAMED remote datasets,
//   SPARQL Update verbs, unsupported clauses, deep nesting, prototype-polluting keys,
//   caller limit escalation, and scan/solution/output limits.

import {
  DEFAULT_BASE_IRI, RDF_TYPE, XSD_NS,
  iriTerm, literalTerm, bnodeTerm, rdfTermKey, rdfTermsEqual,
  buildVisibilityFilter, resolveBoundedLimits, clampLimit, compareCodeUnits,
  factSubjectIri, FORBIDDEN_OBJECT_KEYS,
} from './ontology.mjs';

export const DEFAULT_SPARQL_LIMITS = Object.freeze({
  maxQueryBytes: 16 * 1024,
  maxScanSteps: 100_000,
  maxSolutions: 2_000,
  maxOutputBytes: 512 * 1024,
});

const CALLER_SPARQL_LIMIT_KEYS = Object.freeze(['maxScanSteps', 'maxSolutions', 'maxOutputBytes']);
const MAX_DEPTH = 64;
const MAX_REGEX_PATTERN_LEN = 128;
const MAX_REGEX_INPUT_LEN = 4096;
const MAX_NFA_STATES = 512;
const MAX_QUANTIFIER_REPEAT = 20;

const WRITE_VERBS = new Set([
  'INSERT', 'DELETE', 'LOAD', 'CLEAR', 'DROP', 'CREATE', 'ADD', 'MOVE', 'COPY', 'WITH',
]);

const AGG_FUNCS = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);
const ALLOWED_FILTER_FNS = new Set([
  'BOUND', 'ISIRI', 'ISURI', 'ISLITERAL', 'ISBLANK', 'STR', 'LANG', 'DATATYPE',
  'CONTAINS', 'STRSTARTS', 'STRENDS', 'LCASE', 'UCASE', 'STRLEN', 'REGEX',
]);
const ALLOWED_CMP_OPS = new Set(['=', '!=', '<', '<=', '>', '>=']);

export class SparqlError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'SparqlError';
    this.code = code;
    this.detail = detail ?? null;
  }
}

const bad = (code, detail) => { throw new SparqlError(code, detail); };

export const isLogicVar = (x) => typeof x === 'string' && x.startsWith('?') && x.length > 1;

// --- Linear-Time Thompson NFA REGEX Engine (immune to backtracking ReDoS) ---
// Supports: literals, escapes (\d \w \s \D \W \S \n \t \r \\ etc.), `.`,
// character classes `[...]` / `[^...]`, alternation `|`, groups `(...)` / `(?:...)`,
// quantifiers `*`, `+`, `?`, `{m}`, `{m,}`, `{m,n}` (n <= 20), anchors `^` / `$`, and `i` flag.
// Explicitly refuses backreferences (\1..\9) and lookarounds ((?= (?! (?<= (?<!).

function makeMatcher(spec, { ignoreCase = false, dotAll = false } = {}) {
  const norm = (c) => (ignoreCase ? c.toLowerCase() : c);
  if (spec.kind === 'any') return dotAll ? () => true : (c) => c !== '\n';
  if (spec.kind === 'lit') {
    const target = norm(spec.ch);
    return (c) => norm(c) === target;
  }
  if (spec.kind === 'shorthand') {
    const s = spec.code;
    return (c) => {
      if (s === 'd') return c >= '0' && c <= '9';
      if (s === 'D') return !(c >= '0' && c <= '9');
      if (s === 'w') return /[a-zA-Z0-9_]/.test(c);
      if (s === 'W') return !/[a-zA-Z0-9_]/.test(c);
      if (s === 's') return /\s/.test(c);
      if (s === 'S') return !/\s/.test(c);
      return false;
    };
  }
  if (spec.kind === 'class') {
    const { negated, ranges, chars, shorthands } = spec;
    const normChars = new Set(chars.map(norm));
    const normRanges = ranges.map(([a, b]) => [norm(a), norm(b)]);
    const shortFns = shorthands.map((code) => makeMatcher({ kind: 'shorthand', code }, { ignoreCase, dotAll }));
    return (c) => {
      const nc = norm(c);
      let hit = normChars.has(nc);
      if (!hit) {
        for (const [a, b] of normRanges) {
          if (nc >= a && nc <= b) { hit = true; break; }
        }
      }
      if (!hit) {
        for (const fn of shortFns) { if (fn(c)) { hit = true; break; } }
      }
      return negated ? !hit : hit;
    };
  }
  return () => false;
}

export function compileLinearRegex(pattern, flags = '') {
  if (typeof pattern !== 'string') bad('sparql-bad-regex', 'pattern must be a string');
  if (pattern.length > MAX_REGEX_PATTERN_LEN) {
    bad('sparql-regex-too-complex', `regex pattern exceeds ${MAX_REGEX_PATTERN_LEN} chars`);
  }
  const flagStr = typeof flags === 'string' ? flags : '';
  if (!/^[is]*$/.test(flagStr)) bad('sparql-bad-regex', `unsupported regex flags "${flagStr}"`);
  const ignoreCase = flagStr.includes('i');
  const dotAll = flagStr.includes('s');

  let pos = 0;
  const n = pattern.length;

  function parseEscape(inClass) {
    if (pos >= n) bad('sparql-bad-regex', 'trailing backslash');
    const c = pattern[pos++];
    if (c >= '1' && c <= '9') bad('sparql-regex-too-complex', 'backreferences are forbidden');
    if (c === 'd' || c === 'D' || c === 'w' || c === 'W' || c === 's' || c === 'S') {
      return { kind: 'shorthand', code: c };
    }
    if (c === 'n') return { kind: 'lit', ch: '\n' };
    if (c === 'r') return { kind: 'lit', ch: '\r' };
    if (c === 't') return { kind: 'lit', ch: '\t' };
    if (inClass && c === 'b') return { kind: 'lit', ch: '\b' };
    if (!inClass && (c === 'b' || c === 'B')) bad('sparql-regex-too-complex', `word boundary \\${c} not supported`);
    return { kind: 'lit', ch: c };
  }

  function parseClass() {
    pos += 1; // '['
    let negated = false;
    if (pos < n && pattern[pos] === '^') { negated = true; pos += 1; }
    const chars = [];
    const ranges = [];
    const shorthands = [];
    let closed = false;
    while (pos < n) {
      if (pattern[pos] === ']') { pos += 1; closed = true; break; }
      let item;
      if (pattern[pos] === '\\') { pos += 1; item = parseEscape(true); }
      else { item = { kind: 'lit', ch: pattern[pos++] }; }
      if (item.kind === 'shorthand') { shorthands.push(item.code); continue; }
      if (pos + 1 < n && pattern[pos] === '-' && pattern[pos + 1] !== ']') {
        pos += 1; // '-'
        let endItem;
        if (pattern[pos] === '\\') { pos += 1; endItem = parseEscape(true); }
        else { endItem = { kind: 'lit', ch: pattern[pos++] }; }
        if (endItem.kind !== 'lit' || item.ch > endItem.ch) bad('sparql-bad-regex', 'invalid character range');
        ranges.push([item.ch, endItem.ch]);
      } else {
        chars.push(item.ch);
      }
    }
    if (!closed) bad('sparql-bad-regex', 'unterminated character class');
    return { kind: 'class', negated, ranges, chars, shorthands };
  }

  function parseAtom(depth) {
    if (depth > 32) bad('sparql-regex-too-complex', 'regex nesting too deep');
    const c = pattern[pos];
    if (c === '^') { pos += 1; return { type: 'anchor', which: 'start' }; }
    if (c === '$') { pos += 1; return { type: 'anchor', which: 'end' }; }
    if (c === '.') { pos += 1; return { type: 'char', spec: { kind: 'any' } }; }
    if (c === '[') return { type: 'char', spec: parseClass() };
    if (c === '\\') { pos += 1; return { type: 'char', spec: parseEscape(false) }; }
    if (c === '(') {
      pos += 1;
      if (pattern[pos] === '?') {
        if (pattern[pos + 1] === ':') { pos += 2; }
        else bad('sparql-regex-too-complex', 'lookarounds and named groups are forbidden');
      }
      const sub = parseAlt(depth + 1);
      if (pattern[pos] !== ')') bad('sparql-bad-regex', 'unclosed group');
      pos += 1;
      return sub;
    }
    if (c === '*' || c === '+' || c === '?' || c === '{' || c === ')') {
      bad('sparql-bad-regex', `unexpected "${c}"`);
    }
    pos += 1;
    return { type: 'char', spec: { kind: 'lit', ch: c } };
  }

  function parseQuantified(depth) {
    const atom = parseAtom(depth);
    if (pos >= n) return atom;
    const c = pattern[pos];
    if (c === '*' || c === '+' || c === '?') {
      if (atom.type === 'anchor') bad('sparql-bad-regex', 'cannot quantify anchor');
      pos += 1;
      if (pos < n && pattern[pos] === '?') pos += 1; // non-greedy marker does not affect boolean match
      return { type: 'quant', op: c, child: atom };
    }
    if (c === '{') {
      if (atom.type === 'anchor') bad('sparql-bad-regex', 'cannot quantify anchor');
      const m = /^\{(\d{1,3})(?:,(\d{0,3}))?\}/.exec(pattern.slice(pos));
      if (!m) bad('sparql-bad-regex', 'invalid quantifier');
      const min = Number(m[1]);
      const hasComma = m[2] !== undefined;
      const max = hasComma ? (m[2] === '' ? Infinity : Number(m[2])) : min;
      if (min > MAX_QUANTIFIER_REPEAT || (Number.isFinite(max) && max > MAX_QUANTIFIER_REPEAT) || max < min) {
        bad('sparql-regex-too-complex', `quantifier {${min},${max}} exceeds cap ${MAX_QUANTIFIER_REPEAT}`);
      }
      pos += m[0].length;
      if (pos < n && pattern[pos] === '?') pos += 1;
      return { type: 'repeat', min, max, child: atom };
    }
    return atom;
  }

  function parseSeq(depth) {
    const items = [];
    while (pos < n && pattern[pos] !== '|' && pattern[pos] !== ')') {
      items.push(parseQuantified(depth));
    }
    if (items.length === 0) return { type: 'empty' };
    if (items.length === 1) return items[0];
    return { type: 'seq', items };
  }

  function parseAlt(depth) {
    const branches = [parseSeq(depth)];
    while (pos < n && pattern[pos] === '|') {
      pos += 1;
      branches.push(parseSeq(depth));
    }
    if (branches.length === 1) return branches[0];
    return { type: 'alt', branches };
  }

  const ast = parseAlt(0);
  if (pos !== n) bad('sparql-bad-regex', `unexpected "${pattern[pos]}"`);

  // Compile AST to Thompson NFA states
  const states = [];
  const newState = (s) => {
    if (states.length >= MAX_NFA_STATES) {
      bad('sparql-regex-too-complex', `compiled NFA exceeds ${MAX_NFA_STATES} states`);
    }
    const id = states.length;
    states.push(s);
    return id;
  };

  function compile(node) {
    if (node.type === 'empty') {
      const s = newState({ kind: 'eps', out: [] });
      return { start: s, end: s };
    }
    if (node.type === 'anchor') {
      const end = newState({ kind: 'eps', out: [] });
      const start = newState({ kind: node.which === 'start' ? 'anchor-start' : 'anchor-end', out: [end] });
      return { start, end };
    }
    if (node.type === 'char') {
      const end = newState({ kind: 'eps', out: [] });
      const start = newState({ kind: 'match', fn: makeMatcher(node.spec, { ignoreCase, dotAll }), out: [end] });
      return { start, end };
    }
    if (node.type === 'seq') {
      let frag = compile(node.items[0]);
      for (let k = 1; k < node.items.length; k++) {
        const nextFrag = compile(node.items[k]);
        states[frag.end].out.push(nextFrag.start);
        frag = { start: frag.start, end: nextFrag.end };
      }
      return frag;
    }
    if (node.type === 'alt') {
      const start = newState({ kind: 'eps', out: [] });
      const end = newState({ kind: 'eps', out: [] });
      for (const b of node.branches) {
        const f = compile(b);
        states[start].out.push(f.start);
        states[f.end].out.push(end);
      }
      return { start, end };
    }
    if (node.type === 'quant') {
      const f = compile(node.child);
      const start = newState({ kind: 'eps', out: [] });
      const end = newState({ kind: 'eps', out: [] });
      if (node.op === '*') {
        states[start].out.push(f.start, end);
        states[f.end].out.push(f.start, end);
      } else if (node.op === '+') {
        states[start].out.push(f.start);
        states[f.end].out.push(f.start, end);
      } else { // '?'
        states[start].out.push(f.start, end);
        states[f.end].out.push(end);
      }
      return { start, end };
    }
    if (node.type === 'repeat') {
      const parts = [];
      for (let k = 0; k < node.min; k++) parts.push(compile(node.child));
      if (!Number.isFinite(node.max)) {
        parts.push(compile({ type: 'quant', op: '*', child: node.child }));
      } else {
        for (let k = node.min; k < node.max; k++) {
          parts.push(compile({ type: 'quant', op: '?', child: node.child }));
        }
      }
      if (parts.length === 0) {
        const s = newState({ kind: 'eps', out: [] });
        return { start: s, end: s };
      }
      let cur = parts[0];
      for (let k = 1; k < parts.length; k++) {
        states[cur.end].out.push(parts[k].start);
        cur = { start: cur.start, end: parts[k].end };
      }
      return cur;
    }
    bad('sparql-bad-regex', node.type);
    return null;
  }

  const frag = compile(ast);
  const acceptState = newState({ kind: 'accept', out: [] });
  states[frag.end].out.push(acceptState);

  function epsilonClosure(seedList, idx, strLen) {
    const visited = new Uint8Array(states.length);
    const stack = [];
    const active = [];
    for (const s of seedList) {
      if (!visited[s]) { visited[s] = 1; stack.push(s); }
    }
    while (stack.length > 0) {
      const id = stack.pop();
      const st = states[id];
      if (st.kind === 'eps') {
        for (const nxt of st.out) {
          if (!visited[nxt]) { visited[nxt] = 1; stack.push(nxt); }
        }
      } else if (st.kind === 'anchor-start') {
        if (idx === 0) {
          for (const nxt of st.out) {
            if (!visited[nxt]) { visited[nxt] = 1; stack.push(nxt); }
          }
        }
      } else if (st.kind === 'anchor-end') {
        if (idx === strLen) {
          for (const nxt of st.out) {
            if (!visited[nxt]) { visited[nxt] = 1; stack.push(nxt); }
          }
        }
      } else {
        active.push(id);
      }
    }
    return active;
  }

  return {
    test(input) {
      const str = String(input);
      if (str.length > MAX_REGEX_INPUT_LEN) {
        bad('sparql-regex-input-too-long', `input length ${str.length} exceeds ${MAX_REGEX_INPUT_LEN}`);
      }
      // Unanchored SPARQL REGEX searches anywhere in `str` (equivalent to .*? pattern)
      let current = epsilonClosure([frag.start], 0, str.length);
      if (current.includes(acceptState)) return true;
      for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        const nextSeeds = [frag.start]; // allow match starting at i + 1
        for (const id of current) {
          const st = states[id];
          if (st.kind === 'match' && st.fn(ch)) {
            for (const nxt of st.out) nextSeeds.push(nxt);
          }
        }
        current = epsilonClosure(nextSeeds, i + 1, str.length);
        if (current.includes(acceptState)) return true;
      }
      return false;
    },
  };
}

// --- SPARQL Tokenizer ---

function tokenizeSparql(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === '#') { while (i < n && src[i] !== '\n') i += 1; continue; }
    if (ch === '<' && (src[i + 1] !== '=' && src[i + 1] !== ' ' && src[i + 1] !== '\t' && src[i + 1] !== '\n')) {
      const end = src.indexOf('>', i + 1);
      if (end > i + 1 && !/[\s<]/.test(src.slice(i + 1, end))) {
        tokens.push({ type: 'iri', value: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if ((ch === '?' || ch === '$') && /[a-zA-Z0-9_]/.test(src[i + 1] ?? '')) {
      let j = i + 1;
      while (j < n && /[a-zA-Z0-9_]/.test(src[j])) j += 1;
      tokens.push({ type: 'var', value: `?${src.slice(i + 1, j)}` });
      i = j;
      continue;
    }
    if (ch === '_' && src[i + 1] === ':') {
      let j = i + 2;
      while (j < n && /[a-zA-Z0-9_.-]/.test(src[j])) j += 1;
      tokens.push({ type: 'bnode', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let val = '';
      i += 1;
      let closed = false;
      while (i < n) {
        if (src[i] === '\\' && i + 1 < n) {
          const esc = src[i + 1];
          val += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          i += 2; continue;
        }
        if (src[i] === quote) { i += 1; closed = true; break; }
        val += src[i++];
      }
      if (!closed) bad('sparql-syntax-error', 'unterminated string literal');
      tokens.push({ type: 'string', value: val });
      continue;
    }
    if (ch === '@') {
      let j = i + 1;
      while (j < n && /[a-zA-Z0-9-]/.test(src[j])) j += 1;
      tokens.push({ type: 'lang', value: src.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (ch === '^' && src[i + 1] === '^') {
      tokens.push({ type: 'caret', value: '^^' });
      i += 2;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '&&' || two === '||' || two === '!=' || two === '<=' || two === '>=') {
      tokens.push({ type: 'op', value: two });
      i += 2;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      if (src[j] === '-') j += 1;
      let sawDot = false;
      while (j < n && (/[0-9]/.test(src[j]) || (!sawDot && src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')))) {
        if (src[j] === '.') sawDot = true;
        j += 1;
      }
      const raw = src.slice(i, j);
      tokens.push({ type: 'number', value: Number(raw), isFloat: sawDot });
      i = j;
      continue;
    }
    if ('{}().,;*=<>!+-/'.includes(ch)) {
      tokens.push({ type: 'punc', value: ch });
      i += 1;
      continue;
    }
    if (/[a-zA-Z_:]/.test(ch)) {
      let j = i;
      while (j < n && /[a-zA-Z0-9_.:/-]/.test(src[j])) {
        if (src[j] === '.' && (j + 1 >= n || /[\s;,)}.]/.test(src[j + 1]))) break;
        j += 1;
      }
      const word = src.slice(i, j);
      if (word.includes(':')) {
        tokens.push({ type: 'pname', value: word });
      } else {
        tokens.push({ type: 'word', value: word, upper: word.toUpperCase() });
      }
      i = j;
      continue;
    }
    bad('sparql-syntax-error', `unexpected character "${ch}" at position ${i}`);
  }
  tokens.push({ type: 'eof', value: null });
  return tokens;
}

// --- SPARQL Parser -> Algebra (with bounded recursion depth) ---

export function parseSparql(query, { maxQueryBytes = DEFAULT_SPARQL_LIMITS.maxQueryBytes } = {}) {
  if (typeof query !== 'string' || !query.trim()) bad('sparql-empty', 'SPARQL query must be a non-empty string');
  if (Buffer.byteLength(query, 'utf8') > maxQueryBytes) {
    bad('sparql-query-too-large', `exceeds ${maxQueryBytes} bytes`);
  }
  const tokens = tokenizeSparql(query);
  let pos = 0;

  const peek = (o = 0) => tokens[pos + o] ?? { type: 'eof', value: null };
  const next = () => tokens[pos++];
  const isWord = (kw, o = 0) => peek(o).type === 'word' && peek(o).upper === kw;
  const isPunc = (ch, o = 0) => (peek(o).type === 'punc' || peek(o).type === 'op') && peek(o).value === ch;
  const eatWord = (kw) => { if (isWord(kw)) { next(); return true; } return false; };
  const expectWord = (kw) => { if (!isWord(kw)) bad('sparql-syntax-error', `expected ${kw}, got ${peek().value ?? 'EOF'}`); return next(); };
  const expectPunc = (ch) => { if (!isPunc(ch)) bad('sparql-syntax-error', `expected "${ch}", got ${peek().value ?? 'EOF'}`); return next(); };

  const prefixes = Object.create(null);
  prefixes.rdf = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
  prefixes.xsd = XSD_NS;
  prefixes.onto = DEFAULT_BASE_IRI;
  let baseIri = DEFAULT_BASE_IRI;

  for (;;) {
    if (eatWord('PREFIX')) {
      const p = next();
      if (p.type !== 'pname' || !p.value.endsWith(':')) bad('sparql-syntax-error', `bad PREFIX name "${p.value}"`);
      const pre = p.value.slice(0, -1);
      if (FORBIDDEN_OBJECT_KEYS.has(pre)) bad('sparql-forbidden-prefix', pre);
      const iriTok = next();
      if (iriTok.type !== 'iri') bad('sparql-syntax-error', 'PREFIX requires <IRI>');
      prefixes[pre] = iriTok.value;
    } else if (eatWord('BASE')) {
      const iriTok = next();
      if (iriTok.type !== 'iri') bad('sparql-syntax-error', 'BASE requires <IRI>');
      baseIri = iriTok.value;
    } else {
      break;
    }
  }

  function resolvePname(pname) {
    const idx = pname.indexOf(':');
    const pre = pname.slice(0, idx);
    const local = pname.slice(idx + 1);
    if (!Object.hasOwn(prefixes, pre)) {
      bad('sparql-unknown-prefix', pre);
    }
    return `${prefixes[pre]}${local}`;
  }

  function resolveIri(raw) {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return raw;
    try { return new URL(raw, baseIri).toString(); } catch { return `${baseIri}${raw}`; }
  }

  function parseTerm({ allowVar = true, isPredicate = false } = {}) {
    const t = peek();
    if (t.type === 'var') {
      if (!allowVar) bad('sparql-syntax-error', `variable ${t.value} not allowed here`);
      next();
      return t.value;
    }
    if (isPredicate && t.type === 'word' && t.value === 'a') {
      next();
      return iriTerm(RDF_TYPE);
    }
    if (t.type === 'iri') { next(); return iriTerm(resolveIri(t.value)); }
    if (t.type === 'pname') { next(); return iriTerm(resolvePname(t.value)); }
    if (t.type === 'bnode') { next(); return bnodeTerm(t.value); }
    if (t.type === 'string') {
      next();
      let language;
      let datatype;
      if (peek().type === 'lang') language = next().value;
      else if (peek().type === 'caret') {
        next();
        const dtTok = next();
        if (dtTok.type === 'iri') datatype = resolveIri(dtTok.value);
        else if (dtTok.type === 'pname') datatype = resolvePname(dtTok.value);
        else bad('sparql-syntax-error', 'expected datatype IRI after ^^');
      }
      return literalTerm(t.value, { datatype, language });
    }
    if (t.type === 'number') {
      next();
      return literalTerm(t.value, { datatype: t.isFloat ? `${XSD_NS}decimal` : `${XSD_NS}integer` });
    }
    if (t.type === 'word' && (t.upper === 'TRUE' || t.upper === 'FALSE')) {
      next();
      return literalTerm(t.upper === 'TRUE', { datatype: `${XSD_NS}boolean` });
    }
    bad('sparql-syntax-error', `unexpected token "${t.value ?? 'EOF'}" in term`);
  }

  function checkDepth(depth) {
    if (depth > MAX_DEPTH) bad('sparql-too-deep', `exceeded max nesting depth ${MAX_DEPTH}`);
  }

  function parseFilterPrimary(depth) {
    checkDepth(depth);
    const t = peek();
    if (isPunc('(')) {
      next();
      const e = parseFilterOr(depth + 1);
      expectPunc(')');
      return e;
    }
    if (t.type === 'word' && isPunc('(', 1)) {
      const fn = t.upper;
      if (!ALLOWED_FILTER_FNS.has(fn)) bad('sparql-unsupported-function', `FILTER function "${t.value}" is not allowlisted`);
      next();
      expectPunc('(');
      const args = [];
      if (!isPunc(')')) {
        do { args.push(parseFilterOr(depth + 1)); } while (isPunc(',') && next());
      }
      expectPunc(')');
      return { kind: 'fn', fn, args };
    }
    return { kind: 'term', value: parseTerm({ allowVar: true }) };
  }

  function parseFilterUnary(depth) {
    checkDepth(depth);
    if (isPunc('!')) { next(); return { kind: 'not', expr: parseFilterUnary(depth + 1) }; }
    return parseFilterPrimary(depth);
  }

  function parseFilterComparison(depth) {
    const left = parseFilterUnary(depth);
    const t = peek();
    if ((t.type === 'punc' && (t.value === '=' || t.value === '<' || t.value === '>')) ||
        (t.type === 'op' && (t.value === '!=' || t.value === '<=' || t.value === '>='))) {
      const op = next().value;
      return { kind: 'cmp', op, left, right: parseFilterUnary(depth + 1) };
    }
    return left;
  }

  function parseFilterAnd(depth) {
    let left = parseFilterComparison(depth);
    while (peek().type === 'op' && peek().value === '&&') {
      next();
      left = { kind: 'and', left, right: parseFilterComparison(depth + 1) };
    }
    return left;
  }

  function parseFilterOr(depth) {
    checkDepth(depth);
    let left = parseFilterAnd(depth);
    while (peek().type === 'op' && peek().value === '||') {
      next();
      left = { kind: 'or', left, right: parseFilterAnd(depth + 1) };
    }
    return left;
  }

  function parseTriplePatternsInto(target, graphTerm = null) {
    const subj = parseTerm({ allowVar: true });
    for (;;) {
      const pred = parseTerm({ allowVar: true, isPredicate: true });
      for (;;) {
        const obj = parseTerm({ allowVar: true });
        target.push(graphTerm ? [subj, pred, obj, graphTerm] : [subj, pred, obj]);
        if (isPunc(',')) { next(); continue; }
        break;
      }
      if (isPunc(';')) {
        next();
        if (isPunc('.') || isPunc('}')) break;
        continue;
      }
      break;
    }
    if (isPunc('.')) next();
  }

  function parseGroupGraphPattern(graphTerm = null, depth = 0) {
    checkDepth(depth);
    expectPunc('{');
    let current = null;
    let bgpPatterns = [];
    const filters = [];

    const flushBgp = () => {
      if (bgpPatterns.length > 0) {
        const bgpNode = { op: 'bgp', patterns: bgpPatterns };
        bgpPatterns = [];
        current = current ? { op: 'join', left: current, right: bgpNode } : bgpNode;
      }
    };

    while (!isPunc('}') && peek().type !== 'eof') {
      if (isWord('SERVICE')) {
        bad('service-not-allowed', 'remote SERVICE federation is forbidden (read-only local basis)');
      }
      if (isWord('SELECT')) {
        bad('sparql-unsupported-construct', 'subqueries (nested SELECT) are not supported');
      }
      if (isWord('BIND') || isWord('VALUES') || isWord('MINUS')) {
        bad('sparql-unsupported-construct', `${peek().upper} is not supported`);
      }
      if (isWord('FILTER')) {
        next();
        if (isWord('EXISTS') || isWord('NOT')) bad('sparql-unsupported-construct', 'FILTER [NOT] EXISTS is not supported');
        expectPunc('(');
        const expr = parseFilterOr(0);
        expectPunc(')');
        filters.push(expr);
        if (isPunc('.')) next();
        continue;
      }
      if (isWord('OPTIONAL')) {
        flushBgp();
        next();
        const right = parseGroupGraphPattern(graphTerm, depth + 1);
        current = { op: 'optional', left: current ?? { op: 'bgp', patterns: [] }, right };
        if (isPunc('.')) next();
        continue;
      }
      if (isWord('GRAPH')) {
        flushBgp();
        next();
        const gTerm = parseTerm({ allowVar: true });
        const inner = parseGroupGraphPattern(gTerm, depth + 1);
        current = current ? { op: 'join', left: current, right: inner } : inner;
        if (isPunc('.')) next();
        continue;
      }
      if (isPunc('{')) {
        flushBgp();
        let branch = parseGroupGraphPattern(graphTerm, depth + 1);
        while (eatWord('UNION')) {
          const rhs = parseGroupGraphPattern(graphTerm, depth + 1);
          branch = { op: 'union', left: branch, right: rhs };
        }
        current = current ? { op: 'join', left: current, right: branch } : branch;
        if (isPunc('.')) next();
        continue;
      }
      parseTriplePatternsInto(bgpPatterns, graphTerm);
    }
    expectPunc('}');
    flushBgp();
    let node = current ?? { op: 'bgp', patterns: [] };
    for (const expr of filters) {
      node = { op: 'filter', expr, pattern: node };
    }
    return node;
  }

  const formTok = peek();
  if (formTok.type === 'word' && WRITE_VERBS.has(formTok.upper)) {
    bad('write-query-refused', `SPARQL ${formTok.upper} is forbidden (read-only engine)`);
  }

  let form = null;
  let distinct = false;
  let selectStar = false;
  const projectedVars = [];
  const aggregates = [];
  let template = null;
  let describeTerms = null;

  if (eatWord('SELECT')) {
    form = 'select';
    distinct = eatWord('DISTINCT');
    if (eatWord('REDUCED')) bad('sparql-unsupported-construct', 'REDUCED is not supported');
    if (isPunc('*')) {
      next();
      selectStar = true;
    } else {
      while (!isWord('WHERE') && !isWord('FROM') && !isPunc('{') && peek().type !== 'eof') {
        if (peek().type === 'var') {
          projectedVars.push(next().value);
        } else if (isPunc('(')) {
          next();
          const fnTok = next();
          if (fnTok.type !== 'word' || !AGG_FUNCS.has(fnTok.upper)) {
            bad('sparql-unsupported-construct', `unsupported projection expression "${fnTok.value}"`);
          }
          expectPunc('(');
          const aggDistinct = eatWord('DISTINCT');
          let arg;
          if (isPunc('*')) {
            if (fnTok.upper !== 'COUNT') bad('sparql-syntax-error', `${fnTok.upper}(*) is invalid`);
            next();
            arg = '*';
          } else if (peek().type === 'var') {
            arg = next().value;
          } else {
            bad('sparql-syntax-error', 'aggregate expects a variable or *');
          }
          expectPunc(')');
          expectWord('AS');
          const aliasTok = next();
          if (aliasTok.type !== 'var') bad('sparql-syntax-error', 'AS requires a ?variable');
          expectPunc(')');
          aggregates.push({ fn: fnTok.upper.toLowerCase(), arg, var: aliasTok.value, distinct: aggDistinct });
          projectedVars.push(aliasTok.value);
        } else {
          bad('sparql-syntax-error', `unexpected token "${peek().value}" in SELECT list`);
        }
      }
      if (projectedVars.length === 0) bad('sparql-syntax-error', 'SELECT requires variables or *');
    }
  } else if (eatWord('ASK')) {
    form = 'ask';
  } else if (eatWord('CONSTRUCT')) {
    form = 'construct';
    expectPunc('{');
    template = [];
    while (!isPunc('}') && peek().type !== 'eof') {
      parseTriplePatternsInto(template, null);
    }
    expectPunc('}');
  } else if (eatWord('DESCRIBE')) {
    form = 'describe';
    describeTerms = [];
    while (!isWord('WHERE') && !isWord('FROM') && !isPunc('{') && peek().type !== 'eof') {
      describeTerms.push(parseTerm({ allowVar: true }));
    }
    if (describeTerms.length === 0) bad('sparql-syntax-error', 'DESCRIBE requires at least one ?var or <IRI>');
  } else {
    bad('sparql-unsupported-construct', `unsupported query form "${formTok.value ?? 'EOF'}"`);
  }

  if (isWord('FROM')) {
    bad('remote-dataset-not-allowed', 'FROM / FROM NAMED dataset loading is forbidden (use pinned basisCid)');
  }

  let algebra = null;
  if (form === 'describe' && !isWord('WHERE') && !isPunc('{')) {
    algebra = { op: 'bgp', patterns: [] };
  } else {
    eatWord('WHERE');
    algebra = parseGroupGraphPattern(null, 0);
  }

  let groupBy = [];
  if (eatWord('GROUP')) {
    expectWord('BY');
    while (peek().type === 'var') groupBy.push(next().value);
    if (groupBy.length === 0) bad('sparql-syntax-error', 'GROUP BY requires at least one ?variable');
  }
  if (isWord('HAVING')) {
    bad('sparql-unsupported-construct', 'HAVING is not supported in this SPARQL subset');
  }

  if (groupBy.length > 0 || aggregates.length > 0) {
    algebra = { op: 'group', by: groupBy, aggregates, pattern: algebra };
  }

  if (form === 'select' && !selectStar) {
    algebra = { op: 'project', vars: projectedVars, pattern: algebra };
  }
  if (distinct) {
    algebra = { op: 'distinct', pattern: algebra };
  }

  if (eatWord('ORDER')) {
    expectWord('BY');
    const keys = [];
    while (isWord('ASC') || isWord('DESC') || peek().type === 'var') {
      if (eatWord('DESC')) {
        expectPunc('(');
        const v = next();
        if (v.type !== 'var') bad('sparql-syntax-error', 'DESC() expects a ?variable');
        expectPunc(')');
        keys.push({ var: v.value, desc: true });
      } else if (eatWord('ASC')) {
        expectPunc('(');
        const v = next();
        if (v.type !== 'var') bad('sparql-syntax-error', 'ASC() expects a ?variable');
        expectPunc(')');
        keys.push({ var: v.value, desc: false });
      } else {
        keys.push({ var: next().value, desc: false });
      }
    }
    if (keys.length === 0) bad('sparql-syntax-error', 'ORDER BY requires at least one ?variable');
    algebra = { op: 'order-by', keys, pattern: algebra };
  }

  let limit = null;
  let offset = null;
  for (let k = 0; k < 2; k++) {
    if (eatWord('LIMIT')) {
      const t = next();
      if (t.type !== 'number' || !Number.isInteger(t.value) || t.value < 0) bad('sparql-syntax-error', 'LIMIT requires a non-negative integer');
      limit = t.value;
    } else if (eatWord('OFFSET')) {
      const t = next();
      if (t.type !== 'number' || !Number.isInteger(t.value) || t.value < 0) bad('sparql-syntax-error', 'OFFSET requires a non-negative integer');
      offset = t.value;
    }
  }
  if (limit !== null || offset !== null) {
    algebra = { op: 'slice', ...(offset !== null ? { offset } : {}), ...(limit !== null ? { limit } : {}), pattern: algebra };
  }

  if (peek().type !== 'eof') {
    bad('sparql-syntax-error', `unexpected trailing token "${peek().value}"`);
  }

  const prefixesOut = {};
  for (const [k, v] of Object.entries(prefixes)) prefixesOut[k] = v;
  return { form, prefixes: prefixesOut, algebra, template, describeTerms, projectedVars, selectStar };
}

// --- Structural Validation of JSON / EDN Algebra Trees ---

function validateTerm(t) {
  if (isLogicVar(t)) return;
  if (t && typeof t === 'object' && !Array.isArray(t)) {
    if (t.rdfType === 'iri' || t.rdfType === 'bnode') {
      if (typeof t.value === 'string' && t.value.length > 0) return;
    } else if (t.rdfType === 'literal') {
      if (t.value !== undefined && t.value !== null) return;
    }
  }
  bad('invalid-algebra-term', String(t));
}

function validateFilterExpr(expr, depth = 0) {
  if (depth > MAX_DEPTH) bad('sparql-too-deep', `exceeded max nesting depth ${MAX_DEPTH}`);
  if (!expr || typeof expr !== 'object' || Array.isArray(expr)) bad('invalid-algebra-filter', 'filter expr must be an object');
  switch (expr.kind) {
    case 'term': validateTerm(expr.value); return;
    case 'not': validateFilterExpr(expr.expr, depth + 1); return;
    case 'and':
    case 'or':
      validateFilterExpr(expr.left, depth + 1);
      validateFilterExpr(expr.right, depth + 1);
      return;
    case 'cmp':
      if (!ALLOWED_CMP_OPS.has(expr.op)) bad('invalid-algebra-filter', `bad comparator ${expr.op}`);
      validateFilterExpr(expr.left, depth + 1);
      validateFilterExpr(expr.right, depth + 1);
      return;
    case 'fn':
      if (typeof expr.fn !== 'string' || !ALLOWED_FILTER_FNS.has(expr.fn.toUpperCase()) || !Array.isArray(expr.args)) {
        bad('sparql-unsupported-function', String(expr.fn));
      }
      for (const a of expr.args) validateFilterExpr(a, depth + 1);
      // Pre-validate literal regex patterns once per query
      if (expr.fn.toUpperCase() === 'REGEX' && expr.args[1]?.kind === 'term' && expr.args[1].value?.rdfType === 'literal') {
        const flagsArg = expr.args[2]?.kind === 'term' && expr.args[2].value?.rdfType === 'literal'
          ? String(expr.args[2].value.value) : '';
        compileLinearRegex(String(expr.args[1].value.value), flagsArg);
      }
      return;
    default:
      bad('invalid-algebra-filter', String(expr.kind));
  }
}

function validateAlgebraNode(node, depth = 0) {
  if (depth > MAX_DEPTH) bad('sparql-too-deep', `exceeded max nesting depth ${MAX_DEPTH}`);
  if (!node || typeof node !== 'object' || Array.isArray(node)) bad('invalid-algebra', 'algebra node must be an object');
  switch (node.op) {
    case 'bgp':
      if (!Array.isArray(node.patterns)) bad('invalid-algebra', 'bgp.patterns must be an array');
      for (const p of node.patterns) {
        if (!Array.isArray(p) || (p.length !== 3 && p.length !== 4)) bad('invalid-algebra', 'pattern must have 3 or 4 terms');
        for (const t of p) if (t !== null && t !== undefined) validateTerm(t);
      }
      return;
    case 'filter':
      validateFilterExpr(node.expr, depth + 1);
      validateAlgebraNode(node.pattern, depth + 1);
      return;
    case 'join':
    case 'union':
    case 'optional':
      validateAlgebraNode(node.left, depth + 1);
      validateAlgebraNode(node.right, depth + 1);
      return;
    case 'project':
      if (!Array.isArray(node.vars) || !node.vars.every(isLogicVar)) bad('invalid-algebra', 'project.vars must be ?vars');
      validateAlgebraNode(node.pattern, depth + 1);
      return;
    case 'distinct':
      validateAlgebraNode(node.pattern, depth + 1);
      return;
    case 'order-by':
      if (!Array.isArray(node.keys) || !node.keys.every((k) => k && isLogicVar(k.var))) {
        bad('invalid-algebra', 'order-by.keys invalid');
      }
      validateAlgebraNode(node.pattern, depth + 1);
      return;
    case 'group':
      if (!Array.isArray(node.by) || !node.by.every(isLogicVar)) bad('invalid-algebra', 'group.by invalid');
      if (!Array.isArray(node.aggregates)) bad('invalid-algebra', 'group.aggregates invalid');
      for (const a of node.aggregates) {
        if (!a || !AGG_FUNCS.has(String(a.fn).toUpperCase()) || (a.arg !== '*' && !isLogicVar(a.arg)) || !isLogicVar(a.var)) {
          bad('invalid-algebra', 'invalid aggregate spec');
        }
      }
      validateAlgebraNode(node.pattern, depth + 1);
      return;
    case 'slice':
      if (node.offset !== undefined && (!Number.isInteger(node.offset) || node.offset < 0)) bad('invalid-algebra', 'bad offset');
      if (node.limit !== undefined && (!Number.isInteger(node.limit) || node.limit < 0)) bad('invalid-algebra', 'bad limit');
      validateAlgebraNode(node.pattern, depth + 1);
      return;
    default:
      bad('sparql-unsupported-op', String(node.op));
  }
}

// --- EDN <-> JSON Algebra Conversion (kotoba.sparql/sparql.core compatible) ---

function escapeEdnString(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
}

function termToEdn(term) {
  if (isLogicVar(term)) return term;
  if (term === '*') return ':*';
  if (!term || typeof term !== 'object') return escapeEdnString(String(term));
  if (term.rdfType === 'iri') return `{:rdf/type :iri :value ${escapeEdnString(term.value)}}`;
  if (term.rdfType === 'bnode') return `{:rdf/type :bnode :value ${escapeEdnString(term.value)}}`;
  const valEdn = typeof term.value === 'number' || typeof term.value === 'boolean'
    ? String(term.value)
    : escapeEdnString(term.value);
  const parts = [':rdf/type :literal', `:value ${valEdn}`];
  if (term.datatype) parts.push(`:datatype ${escapeEdnString(term.datatype)}`);
  if (term.language) parts.push(`:language ${escapeEdnString(term.language)}`);
  return `{${parts.join(' ')}}`;
}

function filterToEdn(expr, depth = 0) {
  if (depth > MAX_DEPTH) bad('sparql-too-deep', `exceeded max nesting depth ${MAX_DEPTH}`);
  switch (expr.kind) {
    case 'term': return termToEdn(expr.value);
    case 'not': return `[:not ${filterToEdn(expr.expr, depth + 1)}]`;
    case 'and': return `[:and ${filterToEdn(expr.left, depth + 1)} ${filterToEdn(expr.right, depth + 1)}]`;
    case 'or': return `[:or ${filterToEdn(expr.left, depth + 1)} ${filterToEdn(expr.right, depth + 1)}]`;
    case 'cmp': return `[:${expr.op} ${filterToEdn(expr.left, depth + 1)} ${filterToEdn(expr.right, depth + 1)}]`;
    case 'fn': return `[:fn :${expr.fn.toLowerCase()} ${expr.args.map((a) => filterToEdn(a, depth + 1)).join(' ')}]`;
    default: bad('sparql-unsupported-filter', expr.kind);
  }
}

/** Serialize a SPARQL JSON algebra tree to EDN (sparql.core.cljk shape). */
export function algebraToEdn(node, depth = 0) {
  if (depth > MAX_DEPTH) bad('sparql-too-deep', `exceeded max nesting depth ${MAX_DEPTH}`);
  if (!node || typeof node !== 'object') bad('invalid-algebra', 'node must be an object');
  switch (node.op) {
    case 'bgp': {
      const pats = node.patterns.map((p) => `[${p.map(termToEdn).join(' ')}]`).join(' ');
      return `{:sparql/op :bgp :patterns [${pats}]}`;
    }
    case 'filter':
      return `{:sparql/op :filter :expr ${filterToEdn(node.expr, depth + 1)} :pattern ${algebraToEdn(node.pattern, depth + 1)}}`;
    case 'join':
      return `{:sparql/op :join :left ${algebraToEdn(node.left, depth + 1)} :right ${algebraToEdn(node.right, depth + 1)}}`;
    case 'union':
      return `{:sparql/op :union :left ${algebraToEdn(node.left, depth + 1)} :right ${algebraToEdn(node.right, depth + 1)}}`;
    case 'optional':
      return `{:sparql/op :optional :left ${algebraToEdn(node.left, depth + 1)} :right ${algebraToEdn(node.right, depth + 1)}}`;
    case 'project':
      return `{:sparql/op :project :vars [${node.vars.join(' ')}] :pattern ${algebraToEdn(node.pattern, depth + 1)}}`;
    case 'distinct':
      return `{:sparql/op :distinct :pattern ${algebraToEdn(node.pattern, depth + 1)}}`;
    case 'order-by': {
      const vars = node.keys.map((k) => k.var).join(' ');
      const desc = node.keys.filter((k) => k.desc).map((k) => k.var).join(' ');
      return `{:sparql/op :order-by :vars [${vars}] :desc #{${desc}} :pattern ${algebraToEdn(node.pattern, depth + 1)}}`;
    }
    case 'group': {
      const aggs = node.aggregates.map((a) =>
        `{:fn :${a.fn} :arg ${a.arg === '*' ? ':*' : a.arg} :var ${a.var}${a.distinct ? ' :distinct? true' : ''}}`
      ).join(' ');
      return `{:sparql/op :group :by [${node.by.join(' ')}] :aggregates [${aggs}] :pattern ${algebraToEdn(node.pattern, depth + 1)}}`;
    }
    case 'slice': {
      const parts = [':sparql/op :slice'];
      if (node.offset !== undefined) parts.push(`:offset ${node.offset}`);
      if (node.limit !== undefined) parts.push(`:limit ${node.limit}`);
      parts.push(`:pattern ${algebraToEdn(node.pattern, depth + 1)}`);
      return `{${parts.join(' ')}}`;
    }
    default:
      bad('invalid-algebra-op', String(node.op));
  }
}

function parseEdnValue(src) {
  let i = 0;
  const n = src.length;
  const skipWs = () => {
    while (i < n) {
      if (src[i] === ';') { while (i < n && src[i] !== '\n') i += 1; continue; }
      if (/[\s,]/.test(src[i])) { i += 1; continue; }
      break;
    }
  };
  function read(depth) {
    if (depth > MAX_DEPTH) bad('edn-too-deep', String(depth));
    skipWs();
    if (i >= n) bad('edn-unexpected-eof');
    const ch = src[i];
    if (ch === '{') {
      i += 1;
      const obj = Object.create(null);
      skipWs();
      while (i < n && src[i] !== '}') {
        const rawKey = read(depth + 1);
        if (typeof rawKey !== 'string') bad('edn-invalid-key', 'EDN map key must be a string or keyword');
        const k = rawKey;
        if (FORBIDDEN_OBJECT_KEYS.has(k)) bad('edn-forbidden-key', k);
        const v = read(depth + 1);
        obj[k] = v;
        skipWs();
      }
      if (src[i] !== '}') bad('edn-syntax-error', 'unterminated map');
      i += 1;
      return obj;
    }
    if (ch === '[') {
      i += 1;
      const arr = [];
      skipWs();
      while (i < n && src[i] !== ']') { arr.push(read(depth + 1)); skipWs(); }
      if (src[i] !== ']') bad('edn-syntax-error', 'unterminated vector');
      i += 1;
      return arr;
    }
    if (ch === '#' && src[i + 1] === '{') {
      i += 2;
      const arr = [];
      skipWs();
      while (i < n && src[i] !== '}') { arr.push(read(depth + 1)); skipWs(); }
      if (src[i] !== '}') bad('edn-syntax-error', 'unterminated set');
      i += 1;
      return { $ednSet: arr };
    }
    if (ch === '"') {
      i += 1;
      let val = '';
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < n) {
          const e = src[++i];
          val += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
          i += 1;
        } else val += src[i++];
      }
      if (src[i] !== '"') bad('edn-syntax-error', 'unterminated string');
      i += 1;
      return val;
    }
    let start = i;
    while (i < n && !/[\s,\[\]{}()"';]/.test(src[i])) i += 1;
    const atom = src.slice(start, i);
    if (atom === 'true') return true;
    if (atom === 'false') return false;
    if (atom === 'nil') return null;
    if (/^-?\d+(\.\d+)?$/.test(atom)) return Number(atom);
    return atom;
  }
  const val = read(0);
  skipWs();
  if (i !== n) bad('edn-syntax-error', `trailing characters at ${i}`);
  return val;
}

function ednTermToJson(x) {
  if (typeof x === 'string') return x;
  if (x && typeof x === 'object' && !Array.isArray(x) && typeof x[':rdf/type'] === 'string') {
    const t = x[':rdf/type'].replace(/^:/, '');
    if (t === 'iri') {
      if (typeof x[':value'] !== 'string' || !x[':value'].trim()) bad('edn-invalid-term', 'iri :value must be a non-empty string');
      return iriTerm(x[':value']);
    }
    if (t === 'bnode') {
      if (typeof x[':value'] !== 'string' || !x[':value'].trim()) bad('edn-invalid-term', 'bnode :value must be a non-empty string');
      return bnodeTerm(x[':value']);
    }
    if (t === 'literal') {
      const val = x[':value'];
      if (typeof val !== 'string' && typeof val !== 'number' && typeof val !== 'boolean') {
        bad('edn-invalid-term', 'literal :value must be a string, number, or boolean');
      }
      if (x[':datatype'] !== undefined && typeof x[':datatype'] !== 'string') {
        bad('edn-invalid-term', 'literal :datatype must be a string');
      }
      if (x[':language'] !== undefined && typeof x[':language'] !== 'string') {
        bad('edn-invalid-term', 'literal :language must be a string');
      }
      return literalTerm(val, { datatype: x[':datatype'], language: x[':language'] });
    }
  }
  bad('edn-invalid-term', JSON.stringify(x));
}

function ednFilterToJson(x, depth = 0) {
  if (depth > MAX_DEPTH) bad('edn-too-deep', String(depth));
  if (Array.isArray(x)) {
    if (x.length < 2 || typeof x[0] !== 'string') bad('edn-invalid-filter', 'filter vector requires operator and operand');
    const tag = x[0].replace(/^:/, '');
    if (tag === 'not') return { kind: 'not', expr: ednFilterToJson(x[1], depth + 1) };
    if (tag === 'and' || tag === 'or') {
      if (x.length < 3) bad('edn-invalid-filter', `${tag} requires 2 operands`);
      return { kind: tag, left: ednFilterToJson(x[1], depth + 1), right: ednFilterToJson(x[2], depth + 1) };
    }
    if (tag === 'fn') {
      if (typeof x[1] !== 'string') bad('edn-invalid-filter', 'fn requires function keyword');
      return { kind: 'fn', fn: x[1].replace(/^:/, '').toUpperCase(), args: x.slice(2).map((a) => ednFilterToJson(a, depth + 1)) };
    }
    if (ALLOWED_CMP_OPS.has(tag)) {
      if (x.length < 3) bad('edn-invalid-filter', `${tag} requires 2 operands`);
      return { kind: 'cmp', op: tag, left: ednFilterToJson(x[1], depth + 1), right: ednFilterToJson(x[2], depth + 1) };
    }
    bad('edn-invalid-filter', tag);
  }
  return { kind: 'term', value: ednTermToJson(x) };
}

/** Parse an EDN SPARQL algebra string back into our JSON algebra tree. */
export function ednToAlgebra(edn, { maxQueryBytes = DEFAULT_SPARQL_LIMITS.maxQueryBytes } = {}) {
  if (typeof edn !== 'string' || !edn.trim()) bad('edn-empty', 'EDN algebra string required');
  if (Buffer.byteLength(edn, 'utf8') > maxQueryBytes) {
    bad('sparql-query-too-large', `EDN algebra exceeds ${maxQueryBytes} bytes`);
  }
  const raw = parseEdnValue(edn);
  const expectArr = (v, label) => {
    if (!Array.isArray(v)) bad('edn-invalid-algebra', `${label} must be a vector`);
    return v;
  };
  const expectStr = (v, label) => {
    if (typeof v !== 'string') bad('edn-invalid-algebra', `${label} must be a string or keyword`);
    return v;
  };
  function convert(node, depth) {
    if (depth > MAX_DEPTH) bad('edn-too-deep', String(depth));
    if (!node || typeof node !== 'object' || Array.isArray(node) || typeof node[':sparql/op'] !== 'string') {
      bad('edn-invalid-algebra', 'missing :sparql/op');
    }
    const op = node[':sparql/op'].replace(/^:/, '');
    switch (op) {
      case 'bgp': {
        const pats = expectArr(node[':patterns'] ?? [], ':patterns');
        return {
          op: 'bgp',
          patterns: pats.map((p) => expectArr(p, ':patterns[]').map(ednTermToJson)),
        };
      }
      case 'filter':
        return { op: 'filter', expr: ednFilterToJson(node[':expr'], depth + 1), pattern: convert(node[':pattern'], depth + 1) };
      case 'join':
      case 'union':
      case 'optional':
        return { op, left: convert(node[':left'], depth + 1), right: convert(node[':right'], depth + 1) };
      case 'project':
        return {
          op: 'project',
          vars: expectArr(node[':vars'] ?? [], ':vars').map((v) => expectStr(v, ':vars[]')),
          pattern: convert(node[':pattern'], depth + 1),
        };
      case 'distinct':
        return { op: 'distinct', pattern: convert(node[':pattern'], depth + 1) };
      case 'order-by': {
        const descRaw = node[':desc'] === undefined ? [] : (Array.isArray(node[':desc']?.$ednSet) ? node[':desc'].$ednSet : expectArr(node[':desc'], ':desc'));
        const descSet = new Set(descRaw.map((v) => expectStr(v, ':desc[]')));
        return {
          op: 'order-by',
          keys: expectArr(node[':vars'] ?? [], ':vars').map((v) => {
            const name = expectStr(v, ':vars[]');
            return { var: name, desc: descSet.has(name) };
          }),
          pattern: convert(node[':pattern'], depth + 1),
        };
      }
      case 'group': {
        const byArr = expectArr(node[':by'] ?? [], ':by').map((v) => expectStr(v, ':by[]'));
        const aggsArr = expectArr(node[':aggregates'] ?? [], ':aggregates');
        return {
          op: 'group',
          by: byArr,
          aggregates: aggsArr.map((a) => {
            if (!a || typeof a !== 'object' || Array.isArray(a) || typeof a[':fn'] !== 'string') {
              bad('edn-invalid-algebra', 'aggregate entry must be a map with :fn');
            }
            const rawArg = expectStr(a[':arg'], ':arg');
            const rawVar = expectStr(a[':var'], ':var');
            return {
              fn: a[':fn'].replace(/^:/, ''),
              arg: rawArg === ':*' ? '*' : rawArg,
              var: rawVar,
              distinct: Boolean(a[':distinct?']),
            };
          }),
          pattern: convert(node[':pattern'], depth + 1),
        };
      }
      case 'slice': {
        if (node[':offset'] !== undefined && typeof node[':offset'] !== 'number') {
          bad('edn-invalid-algebra', ':offset must be a number');
        }
        if (node[':limit'] !== undefined && typeof node[':limit'] !== 'number') {
          bad('edn-invalid-algebra', ':limit must be a number');
        }
        return {
          op: 'slice',
          ...(node[':offset'] !== undefined ? { offset: node[':offset'] } : {}),
          ...(node[':limit'] !== undefined ? { limit: node[':limit'] } : {}),
          pattern: convert(node[':pattern'], depth + 1),
        };
      }
      default:
        bad('edn-unsupported-op', op);
    }
  }
  const tree = convert(raw, 0);
  validateAlgebraNode(tree, 0);
  return tree;
}

// --- SPARQL Algebra Evaluator ---

function numericValue(term) {
  if (!term || term.rdfType !== 'literal') return null;
  const v = term.value;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  return null;
}

function compareTerms(a, b) {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const na = numericValue(a), nb = numericValue(b);
  if (na !== null && nb !== null) return na - nb;
  if (a.rdfType !== b.rdfType) return compareCodeUnits(a.rdfType, b.rdfType);
  return compareCodeUnits(a.value, b.value);
}

function getCompiledRegex(pat, flags, state) {
  const key = `${pat}\0${flags}`;
  let compiled = state.regexCache.get(key);
  if (!compiled) {
    if (state.regexCache.size >= 64) bad('sparql-regex-too-complex', 'too many distinct regex patterns');
    compiled = compileLinearRegex(pat, flags);
    state.regexCache.set(key, compiled);
  }
  return compiled;
}

function evalFilterExpr(expr, binding, state, depth = 0) {
  if (depth > MAX_DEPTH) bad('sparql-too-deep', `exceeded max nesting depth ${MAX_DEPTH}`);
  switch (expr.kind) {
    case 'term': {
      const t = expr.value;
      if (isLogicVar(t)) return Object.hasOwn(binding, t) ? binding[t] : null;
      return t;
    }
    case 'not': return !truthyTerm(evalFilterExpr(expr.expr, binding, state, depth + 1));
    case 'and':
      return truthyTerm(evalFilterExpr(expr.left, binding, state, depth + 1))
        && truthyTerm(evalFilterExpr(expr.right, binding, state, depth + 1));
    case 'or':
      return truthyTerm(evalFilterExpr(expr.left, binding, state, depth + 1))
        || truthyTerm(evalFilterExpr(expr.right, binding, state, depth + 1));
    case 'cmp': {
      const l = evalFilterExpr(expr.left, binding, state, depth + 1);
      const r = evalFilterExpr(expr.right, binding, state, depth + 1);
      if (!l || !r) return false;
      if (expr.op === '=') {
        const nl = numericValue(l), nr = numericValue(r);
        if (nl !== null && nr !== null) return nl === nr;
        return rdfTermsEqual(l, r);
      }
      if (expr.op === '!=') {
        const nl = numericValue(l), nr = numericValue(r);
        if (nl !== null && nr !== null) return nl !== nr;
        return !rdfTermsEqual(l, r);
      }
      const c = compareTerms(l, r);
      if (expr.op === '<') return c < 0;
      if (expr.op === '<=') return c <= 0;
      if (expr.op === '>') return c > 0;
      if (expr.op === '>=') return c >= 0;
      return false;
    }
    case 'fn': {
      const fn = expr.fn.toUpperCase();
      if (fn === 'BOUND') {
        const arg = expr.args[0];
        if (!arg || arg.kind !== 'term' || !isLogicVar(arg.value)) bad('sparql-syntax-error', 'BOUND expects a ?var');
        return Object.hasOwn(binding, arg.value);
      }
      const vals = expr.args.map((a) => evalFilterExpr(a, binding, state, depth + 1));
      const v0 = vals[0];
      if (fn === 'ISIRI' || fn === 'ISURI') return v0?.rdfType === 'iri';
      if (fn === 'ISLITERAL') return v0?.rdfType === 'literal';
      if (fn === 'ISBLANK') return v0?.rdfType === 'bnode';
      if (fn === 'STR') return v0 ? literalTerm(String(v0.value)) : null;
      if (fn === 'LANG') return v0?.rdfType === 'literal' ? literalTerm(v0.language ?? '') : literalTerm('');
      if (fn === 'DATATYPE') return v0?.rdfType === 'literal' && v0.datatype ? iriTerm(v0.datatype) : null;
      if (fn === 'LCASE') return v0 ? literalTerm(String(v0.value).toLowerCase()) : null;
      if (fn === 'UCASE') return v0 ? literalTerm(String(v0.value).toUpperCase()) : null;
      if (fn === 'STRLEN') return v0 ? literalTerm(String(v0.value).length) : null;
      if (fn === 'CONTAINS') return Boolean(v0 && vals[1] && String(v0.value).includes(String(vals[1].value)));
      if (fn === 'STRSTARTS') return Boolean(v0 && vals[1] && String(v0.value).startsWith(String(vals[1].value)));
      if (fn === 'STRENDS') return Boolean(v0 && vals[1] && String(v0.value).endsWith(String(vals[1].value)));
      if (fn === 'REGEX') {
        if (!v0 || !vals[1]) return false;
        const inputStr = String(v0.value);
        const patStr = String(vals[1].value);
        const flagsStr = vals[2] ? String(vals[2].value) : '';
        // Charge scan steps proportional to input length so REGEX loops cannot bypass maxScanSteps
        state.tick(Math.max(1, Math.ceil(inputStr.length / 64)));
        const compiled = getCompiledRegex(patStr, flagsStr, state);
        return compiled.test(inputStr);
      }
      bad('sparql-unsupported-function', expr.fn);
      return false;
    }
    default:
      bad('sparql-unsupported-filter', expr.kind);
      return false;
  }
}

function truthyTerm(v) {
  if (typeof v === 'boolean') return v;
  if (!v) return false;
  if (v.rdfType === 'literal') {
    if (typeof v.value === 'boolean') return v.value;
    if (typeof v.value === 'number') return v.value !== 0;
    return String(v.value).length > 0;
  }
  return true;
}

function matchComponent(pat, quadTerm, binding) {
  if (isLogicVar(pat)) {
    if (Object.hasOwn(binding, pat)) {
      return rdfTermsEqual(binding[pat], quadTerm) ? binding : null;
    }
    return { ...binding, [pat]: quadTerm };
  }
  return rdfTermsEqual(pat, quadTerm) ? binding : null;
}

function matchPattern(pattern, quad, binding) {
  let b = matchComponent(pattern[0], quad.subject, binding);
  if (!b) return null;
  b = matchComponent(pattern[1], quad.predicate, b);
  if (!b) return null;
  b = matchComponent(pattern[2], quad.object, b);
  if (!b) return null;
  if (pattern.length >= 4 && pattern[3] !== null && pattern[3] !== undefined) {
    if (!quad.graph) return null;
    b = matchComponent(pattern[3], quad.graph, b);
  }
  return b;
}

function compatibleMerge(left, right) {
  for (const [k, v] of Object.entries(left)) {
    if (Object.hasOwn(right, k) && !rdfTermsEqual(v, right[k])) return null;
  }
  return { ...left, ...right };
}

function evalAggregate(agg, rows) {
  const bound = agg.arg === '*' ? rows : rows.filter((r) => Object.hasOwn(r, agg.arg));
  let vals = agg.arg === '*' ? null : bound.map((r) => r[agg.arg]);
  if (agg.distinct && vals) {
    const seen = new Set();
    vals = vals.filter((t) => {
      const k = rdfTermKey(t);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  if (agg.fn === 'count') {
    if (agg.arg === '*') {
      if (!agg.distinct) return literalTerm(bound.length);
      const seen = new Set(bound.map((r) => JSON.stringify(r)));
      return literalTerm(seen.size);
    }
    return literalTerm(vals.length);
  }
  const nums = (vals ?? []).map(numericValue).filter((x) => x !== null);
  if (nums.length === 0) return null;
  if (agg.fn === 'sum') {
    let s = 0;
    for (const x of nums) s += x;
    return literalTerm(s);
  }
  if (agg.fn === 'min') {
    let m = nums[0];
    for (let i = 1; i < nums.length; i++) if (nums[i] < m) m = nums[i];
    return literalTerm(m);
  }
  if (agg.fn === 'max') {
    let m = nums[0];
    for (let i = 1; i < nums.length; i++) if (nums[i] > m) m = nums[i];
    return literalTerm(m);
  }
  if (agg.fn === 'avg') {
    let s = 0;
    for (const x of nums) s += x;
    return literalTerm(s / nums.length);
  }
  bad('sparql-unsupported-aggregate', agg.fn);
  return null;
}

function evaluateAlgebra(node, quads, state, depth = 0) {
  if (depth > MAX_DEPTH) bad('sparql-too-deep', `exceeded max nesting depth ${MAX_DEPTH}`);
  const capSolutions = (sols) => {
    if (sols.length > state.limits.maxSolutions * 4) {
      bad('solution-limit-exceeded', 'intermediate solutions exceeded cap');
    }
    return sols;
  };

  switch (node.op) {
    case 'bgp': {
      let current = [{}];
      for (const pat of node.patterns) {
        const next = [];
        for (const b of current) {
          for (const q of quads) {
            state.tick(1);
            const m = matchPattern(pat, q, b);
            if (m) next.push(m);
          }
        }
        current = capSolutions(next);
      }
      return current;
    }
    case 'filter': {
      const rows = evaluateAlgebra(node.pattern, quads, state, depth + 1);
      return rows.filter((b) => truthyTerm(evalFilterExpr(node.expr, b, state, 0)));
    }
    case 'join': {
      const lefts = evaluateAlgebra(node.left, quads, state, depth + 1);
      const rights = evaluateAlgebra(node.right, quads, state, depth + 1);
      const out = [];
      for (const l of lefts) {
        for (const r of rights) {
          state.tick(1);
          const merged = compatibleMerge(l, r);
          if (merged) out.push(merged);
        }
      }
      return capSolutions(out);
    }
    case 'union': {
      const lefts = evaluateAlgebra(node.left, quads, state, depth + 1);
      const rights = evaluateAlgebra(node.right, quads, state, depth + 1);
      return capSolutions([...lefts, ...rights]);
    }
    case 'optional': {
      const lefts = evaluateAlgebra(node.left, quads, state, depth + 1);
      const rights = evaluateAlgebra(node.right, quads, state, depth + 1);
      const out = [];
      for (const l of lefts) {
        let matched = false;
        for (const r of rights) {
          state.tick(1);
          const merged = compatibleMerge(l, r);
          if (merged) { out.push(merged); matched = true; }
        }
        if (!matched) out.push(l);
      }
      return capSolutions(out);
    }
    case 'group': {
      const rows = evaluateAlgebra(node.pattern, quads, state, depth + 1);
      const groups = new Map();
      if (node.by && node.by.length > 0) {
        for (const r of rows) {
          const keyObj = {};
          const keyParts = [];
          for (const v of node.by) {
            if (Object.hasOwn(r, v)) {
              keyObj[v] = r[v];
              keyParts.push(rdfTermKey(r[v]));
            } else {
              keyParts.push('');
            }
          }
          const ks = keyParts.join('|');
          let g = groups.get(ks);
          if (!g) { g = { keyObj, rows: [] }; groups.set(ks, g); }
          g.rows.push(r);
        }
      } else {
        groups.set('__all__', { keyObj: {}, rows });
      }
      const out = [];
      for (const { keyObj, rows: gRows } of groups.values()) {
        const row = { ...keyObj };
        for (const agg of node.aggregates) {
          const val = evalAggregate(agg, gRows);
          if (val !== null) row[agg.var] = val;
        }
        out.push(row);
      }
      return out;
    }
    case 'project': {
      const rows = evaluateAlgebra(node.pattern, quads, state, depth + 1);
      return rows.map((r) => {
        const p = {};
        for (const v of node.vars) {
          if (Object.hasOwn(r, v)) p[v] = r[v];
        }
        return p;
      });
    }
    case 'distinct': {
      const rows = evaluateAlgebra(node.pattern, quads, state, depth + 1);
      const seen = new Set();
      return rows.filter((r) => {
        const k = Object.keys(r).sort().map((v) => `${v}=${rdfTermKey(r[v])}`).join('&');
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    case 'order-by': {
      const rows = [...evaluateAlgebra(node.pattern, quads, state, depth + 1)];
      rows.sort((a, b) => {
        for (const { var: v, desc } of node.keys) {
          const c = compareTerms(a[v], b[v]);
          if (c !== 0) return desc ? -c : c;
        }
        return 0;
      });
      return rows;
    }
    case 'slice': {
      let rows = evaluateAlgebra(node.pattern, quads, state, depth + 1);
      if (node.offset) rows = rows.slice(node.offset);
      if (node.limit !== undefined) rows = rows.slice(0, node.limit);
      return rows;
    }
    default:
      bad('sparql-unsupported-op', String(node.op));
      return [];
  }
}

/**
 * Execute a read-only SPARQL query string, JSON algebra, or EDN algebra against a pinned OntologySnapshot.
 */
export function executeSparql(snapshot, queryOrAlgebra, opts = {}) {
  if (!snapshot || !Array.isArray(snapshot.quads)) bad('invalid-snapshot', 'verified OntologySnapshot required');
  if (opts.basisCid && snapshot.basisCid !== opts.basisCid) {
    bad('basis-cid-mismatch', `expected ${opts.basisCid}, got ${snapshot.basisCid}`);
  }
  const hardCaps = { ...DEFAULT_SPARQL_LIMITS, ...(opts.hardLimits ?? {}) };
  const limits = resolveBoundedLimits(opts.limits, hardCaps, CALLER_SPARQL_LIMIT_KEYS, SparqlError);
  if (opts.maxScanSteps !== undefined) {
    limits.maxScanSteps = clampLimit(opts.maxScanSteps, limits.maxScanSteps, hardCaps.maxScanSteps, 'maxScanSteps', SparqlError);
  }
  if (opts.maxSolutions !== undefined) {
    limits.maxSolutions = clampLimit(opts.maxSolutions, limits.maxSolutions, hardCaps.maxSolutions, 'maxSolutions', SparqlError);
  }
  if (opts.maxOutputBytes !== undefined) {
    limits.maxOutputBytes = clampLimit(opts.maxOutputBytes, limits.maxOutputBytes, hardCaps.maxOutputBytes, 'maxOutputBytes', SparqlError);
  }

  let parsed;
  if (typeof queryOrAlgebra === 'string') {
    parsed = parseSparql(queryOrAlgebra, { maxQueryBytes: limits.maxQueryBytes });
  } else if (queryOrAlgebra && typeof queryOrAlgebra === 'object' && typeof queryOrAlgebra.edn === 'string') {
    const algebra = ednToAlgebra(queryOrAlgebra.edn, { maxQueryBytes: limits.maxQueryBytes });
    parsed = { form: queryOrAlgebra.form ?? 'select', prefixes: {}, algebra, projectedVars: [], selectStar: true };
  } else if (queryOrAlgebra && typeof queryOrAlgebra === 'object' && typeof queryOrAlgebra.op === 'string') {
    const serializedLen = Buffer.byteLength(JSON.stringify(queryOrAlgebra), 'utf8');
    if (serializedLen > limits.maxQueryBytes) {
      bad('sparql-query-too-large', `JSON algebra exceeds ${limits.maxQueryBytes} bytes`);
    }
    validateAlgebraNode(queryOrAlgebra, 0);
    parsed = { form: opts.form ?? 'select', prefixes: {}, algebra: queryOrAlgebra, projectedVars: [], selectStar: true };
  } else {
    bad('invalid-sparql-input', 'expected SPARQL string, JSON algebra, or { edn }');
  }

  validateAlgebraNode(parsed.algebra, 0);

  // Fail-closed visibility filter over quads:
  // When jurisdiction or allowedSources is active, quads without matching fact provenance are REFUSED.
  const policyFilter = buildVisibilityFilter({
    jurisdiction: opts.jurisdiction,
    allowedSources: opts.allowedSources,
  });
  const hasDeclarativePolicy = opts.jurisdiction !== undefined || opts.allowedSources !== undefined;
  const subjectMeta = new Map();
  if (hasDeclarativePolicy && Array.isArray(snapshot.facts)) {
    const baseIri = snapshot.baseIri ?? DEFAULT_BASE_IRI;
    for (const f of snapshot.facts) {
      subjectMeta.set(factSubjectIri(f, baseIri), f);
    }
  }
  const visibleQuads = snapshot.quads.filter((q) => {
    if (hasDeclarativePolicy) {
      const meta = subjectMeta.get(q.subject.value) ?? {};
      if (!policyFilter(meta)) return false;
    }
    if (typeof opts.visible === 'function' && !opts.visible(q)) return false;
    return true;
  });

  const state = {
    steps: 0,
    limits,
    regexCache: new Map(),
    tick(n = 1) {
      this.steps += n;
      if (this.steps > this.limits.maxScanSteps) {
        bad('scan-limit-exceeded', `exceeded maxScanSteps=${this.limits.maxScanSteps}`);
      }
    },
  };

  const rawSolutions = evaluateAlgebra(parsed.algebra, visibleQuads, state, 0);
  const algebraEdn = algebraToEdn(parsed.algebra, 0);

  if (parsed.form === 'ask') {
    return {
      basisCid: snapshot.basisCid,
      form: 'ask',
      boolean: rawSolutions.length > 0,
      scannedSteps: state.steps,
      algebra: parsed.algebra,
      algebraEdn,
      readOnly: true,
      limits,
    };
  }

  if (parsed.form === 'construct') {
    const seen = new Map();
    for (const b of rawSolutions) {
      for (const [s, p, o] of parsed.template) {
        const rs = isLogicVar(s) ? b[s] : s;
        const rp = isLogicVar(p) ? b[p] : p;
        const ro = isLogicVar(o) ? b[o] : o;
        if (!rs || !rp || !ro) continue;
        const key = `${rdfTermKey(rs)}|${rdfTermKey(rp)}|${rdfTermKey(ro)}`;
        if (!seen.has(key)) {
          if (seen.size >= limits.maxSolutions) {
            bad('solution-limit-exceeded', `CONSTRUCT exceeded maxSolutions=${limits.maxSolutions}`);
          }
          seen.set(key, { subject: rs, predicate: rp, object: ro });
        }
      }
    }
    const graph = [...seen.values()];
    const outputBytes = Buffer.byteLength(JSON.stringify(graph), 'utf8');
    if (outputBytes > limits.maxOutputBytes) {
      bad('output-size-exceeded', `CONSTRUCT output ${outputBytes} exceeds maxOutputBytes=${limits.maxOutputBytes}`);
    }
    return {
      basisCid: snapshot.basisCid,
      form: 'construct',
      quads: graph,
      count: graph.length,
      scannedSteps: state.steps,
      algebra: parsed.algebra,
      algebraEdn,
      readOnly: true,
      limits,
    };
  }

  if (parsed.form === 'describe') {
    const wanted = new Set();
    for (const t of parsed.describeTerms) {
      if (isLogicVar(t)) {
        for (const b of rawSolutions) if (b[t]) wanted.add(rdfTermKey(b[t]));
      } else {
        wanted.add(rdfTermKey(t));
      }
    }
    const described = [];
    for (const q of visibleQuads) {
      if (!wanted.has(rdfTermKey(q.subject))) continue;
      if (described.length >= limits.maxSolutions) {
        bad('solution-limit-exceeded', `DESCRIBE exceeded maxSolutions=${limits.maxSolutions}`);
      }
      described.push(q);
    }
    const outputBytes = Buffer.byteLength(JSON.stringify(described), 'utf8');
    if (outputBytes > limits.maxOutputBytes) {
      bad('output-size-exceeded', `DESCRIBE output ${outputBytes} exceeds maxOutputBytes=${limits.maxOutputBytes}`);
    }
    return {
      basisCid: snapshot.basisCid,
      form: 'describe',
      quads: described,
      count: described.length,
      scannedSteps: state.steps,
      algebra: parsed.algebra,
      algebraEdn,
      readOnly: true,
      limits,
    };
  }

  if (rawSolutions.length > limits.maxSolutions) {
    bad('solution-limit-exceeded', `result has ${rawSolutions.length} solutions (maxSolutions=${limits.maxSolutions}; add LIMIT)`);
  }

  const varSet = new Set(parsed.projectedVars ?? []);
  if (varSet.size === 0) {
    for (const r of rawSolutions) for (const k of Object.keys(r)) varSet.add(k);
  }
  const variables = [...varSet];
  const rows = rawSolutions.map((b) => {
    const row = {};
    for (const v of variables) row[v] = b[v] ? b[v].value : null;
    return row;
  });

  const outputBytes = Buffer.byteLength(JSON.stringify(rawSolutions), 'utf8');
  if (outputBytes > limits.maxOutputBytes) {
    bad('output-size-exceeded', `result size ${outputBytes} exceeds maxOutputBytes=${limits.maxOutputBytes}`);
  }

  return {
    basisCid: snapshot.basisCid,
    form: 'select',
    variables,
    bindings: rawSolutions,
    rows,
    rowCount: rawSolutions.length,
    scannedSteps: state.steps,
    algebra: parsed.algebra,
    algebraEdn,
    readOnly: true,
    limits,
  };
}
