// Bounded, read-only, basis-pinned SPARQL parser, EDN/JSON algebra bridge, and evaluator
// over rdf.core-shaped quads from an OntologySnapshot.
//
// Aligns with kotoba/lib/kotoba.sparql/src/sparql/core.cljk:
// - Algebra ops: :bgp, :filter, :join, :union, :optional, :group, :project, :distinct, :order-by, :slice
// - Query forms: SELECT, ASK, CONSTRUCT, DESCRIBE
// - Strict fail-closed refusals: remote SERVICE, FROM/FROM NAMED remote datasets,
//   SPARQL Update verbs (INSERT/DELETE/LOAD/CLEAR/DROP/CREATE/ADD/MOVE/COPY),
//   unsupported clauses, and scan/solution/output limits.

import {
  DEFAULT_BASE_IRI, RDF_TYPE, XSD_NS,
  iriTerm, literalTerm, bnodeTerm, rdfTermKey, rdfTermsEqual, buildVisibilityFilter,
} from './ontology.mjs';

export const DEFAULT_SPARQL_LIMITS = Object.freeze({
  maxQueryBytes: 16 * 1024,
  maxScanSteps: 100_000,
  maxSolutions: 2_000,
  maxOutputBytes: 512 * 1024,
});

const WRITE_VERBS = new Set([
  'INSERT', 'DELETE', 'LOAD', 'CLEAR', 'DROP', 'CREATE', 'ADD', 'MOVE', 'COPY', 'WITH',
]);

const AGG_FUNCS = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);

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

// --- SPARQL Tokenizer ---

function tokenizeSparql(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === '#') { while (i < n && src[i] !== '\n') i += 1; continue; }
    // IRI <...>
    if (ch === '<' && (src[i + 1] !== '=' && src[i + 1] !== ' ' && src[i + 1] !== '\t' && src[i + 1] !== '\n')) {
      const end = src.indexOf('>', i + 1);
      if (end > i + 1 && !/[\s<]/.test(src.slice(i + 1, end))) {
        tokens.push({ type: 'iri', value: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    // Variable ?foo or $foo
    if ((ch === '?' || ch === '$') && /[a-zA-Z0-9_]/.test(src[i + 1] ?? '')) {
      let j = i + 1;
      while (j < n && /[a-zA-Z0-9_]/.test(src[j])) j += 1;
      tokens.push({ type: 'var', value: `?${src.slice(i + 1, j)}` });
      i = j;
      continue;
    }
    // Blank node _:id
    if (ch === '_' && src[i + 1] === ':') {
      let j = i + 2;
      while (j < n && /[a-zA-Z0-9_.-]/.test(src[j])) j += 1;
      tokens.push({ type: 'bnode', value: src.slice(i, j) });
      i = j;
      continue;
    }
    // String literal "..." or '...'
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
    // Language tag @ja or @en-US
    if (ch === '@') {
      let j = i + 1;
      while (j < n && /[a-zA-Z0-9-]/.test(src[j])) j += 1;
      tokens.push({ type: 'lang', value: src.slice(i + 1, j) });
      i = j;
      continue;
    }
    // ^^ datatype marker
    if (ch === '^' && src[i + 1] === '^') {
      tokens.push({ type: 'caret', value: '^^' });
      i += 2;
      continue;
    }
    // Two-char operators
    const two = src.slice(i, i + 2);
    if (two === '&&' || two === '||' || two === '!=' || two === '<=' || two === '>=') {
      tokens.push({ type: 'op', value: two });
      i += 2;
      continue;
    }
    // Signed or unsigned number
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
    // Punctuation
    if ('{}().,;*=<>!+-/'.includes(ch)) {
      tokens.push({ type: 'punc', value: ch });
      i += 1;
      continue;
    }
    // Prefixed name or keyword (e.g. ex:tender, :status, SELECT, a)
    if (/[a-zA-Z_:]/.test(ch)) {
      let j = i;
      while (j < n && /[a-zA-Z0-9_.:/-]/.test(src[j])) {
        // Don't swallow a trailing '.' that terminates a triple pattern
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

// --- SPARQL Parser -> Algebra ---

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

  const prefixes = {
    rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    xsd: XSD_NS,
    onto: DEFAULT_BASE_IRI,
  };
  let baseIri = DEFAULT_BASE_IRI;

  // Prologue: BASE / PREFIX
  for (;;) {
    if (eatWord('PREFIX')) {
      const p = next();
      if (p.type !== 'pname' || !p.value.endsWith(':')) bad('sparql-syntax-error', `bad PREFIX name "${p.value}"`);
      const iriTok = next();
      if (iriTok.type !== 'iri') bad('sparql-syntax-error', 'PREFIX requires <IRI>');
      prefixes[p.value.slice(0, -1)] = iriTok.value;
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
    if (!Object.prototype.hasOwnProperty.call(prefixes, pre)) {
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

  // Filter expressions
  function parseFilterPrimary() {
    const t = peek();
    if (isPunc('(')) {
      next();
      const e = parseFilterOr();
      expectPunc(')');
      return e;
    }
    if (t.type === 'word' && isPunc('(', 1)) {
      const fn = t.upper;
      const ALLOWED_FILTER_FNS = new Set([
        'BOUND', 'ISIRI', 'ISURI', 'ISLITERAL', 'ISBLANK', 'STR', 'LANG', 'DATATYPE',
        'CONTAINS', 'STRSTARTS', 'STRENDS', 'LCASE', 'UCASE', 'STRLEN', 'REGEX',
      ]);
      if (!ALLOWED_FILTER_FNS.has(fn)) bad('sparql-unsupported-function', `FILTER function "${t.value}" is not allowlisted`);
      next();
      expectPunc('(');
      const args = [];
      if (!isPunc(')')) {
        do { args.push(parseFilterOr()); } while (isPunc(',') && next());
      }
      expectPunc(')');
      return { kind: 'fn', fn, args };
    }
    return { kind: 'term', value: parseTerm({ allowVar: true }) };
  }

  function parseFilterUnary() {
    if (isPunc('!')) { next(); return { kind: 'not', expr: parseFilterUnary() }; }
    return parseFilterPrimary();
  }

  function parseFilterComparison() {
    const left = parseFilterUnary();
    const t = peek();
    if ((t.type === 'punc' && (t.value === '=' || t.value === '<' || t.value === '>')) ||
        (t.type === 'op' && (t.value === '!=' || t.value === '<=' || t.value === '>='))) {
      const op = next().value;
      return { kind: 'cmp', op, left, right: parseFilterUnary() };
    }
    return left;
  }

  function parseFilterAnd() {
    let left = parseFilterComparison();
    while (peek().type === 'op' && peek().value === '&&') {
      next();
      left = { kind: 'and', left, right: parseFilterComparison() };
    }
    return left;
  }

  function parseFilterOr() {
    let left = parseFilterAnd();
    while (peek().type === 'op' && peek().value === '||') {
      next();
      left = { kind: 'or', left, right: parseFilterAnd() };
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

  function parseGroupGraphPattern(graphTerm = null) {
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
        const expr = parseFilterOr();
        expectPunc(')');
        filters.push(expr);
        if (isPunc('.')) next();
        continue;
      }
      if (isWord('OPTIONAL')) {
        flushBgp();
        next();
        const right = parseGroupGraphPattern(graphTerm);
        current = { op: 'optional', left: current ?? { op: 'bgp', patterns: [] }, right };
        if (isPunc('.')) next();
        continue;
      }
      if (isWord('GRAPH')) {
        flushBgp();
        next();
        const gTerm = parseTerm({ allowVar: true });
        const inner = parseGroupGraphPattern(gTerm);
        current = current ? { op: 'join', left: current, right: inner } : inner;
        if (isPunc('.')) next();
        continue;
      }
      if (isPunc('{')) {
        flushBgp();
        let branch = parseGroupGraphPattern(graphTerm);
        while (eatWord('UNION')) {
          const rhs = parseGroupGraphPattern(graphTerm);
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

  // Check query form verb (fail closed on write/update verbs)
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

  // Reject remote dataset clauses FROM / FROM NAMED
  if (isWord('FROM')) {
    bad('remote-dataset-not-allowed', 'FROM / FROM NAMED dataset loading is forbidden (use pinned basisCid)');
  }

  let algebra = null;
  if (form === 'describe' && !isWord('WHERE') && !isPunc('{')) {
    algebra = { op: 'bgp', patterns: [] };
  } else {
    eatWord('WHERE');
    algebra = parseGroupGraphPattern(null);
  }

  // Solution modifiers: GROUP BY, HAVING (rejected), ORDER BY, LIMIT, OFFSET
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

  return { form, prefixes, algebra, template, describeTerms, projectedVars, selectStar };
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
  const parts = [`:rdf/type :literal`, `:value ${valEdn}`];
  if (term.datatype) parts.push(`:datatype ${escapeEdnString(term.datatype)}`);
  if (term.language) parts.push(`:language ${escapeEdnString(term.language)}`);
  return `{${parts.join(' ')}}`;
}

function filterToEdn(expr) {
  switch (expr.kind) {
    case 'term': return termToEdn(expr.value);
    case 'not': return `[:not ${filterToEdn(expr.expr)}]`;
    case 'and': return `[:and ${filterToEdn(expr.left)} ${filterToEdn(expr.right)}]`;
    case 'or': return `[:or ${filterToEdn(expr.left)} ${filterToEdn(expr.right)}]`;
    case 'cmp': return `[:${expr.op} ${filterToEdn(expr.left)} ${filterToEdn(expr.right)}]`;
    case 'fn': return `[:fn :${expr.fn.toLowerCase()} ${expr.args.map(filterToEdn).join(' ')}]`;
    default: bad('sparql-unsupported-filter', expr.kind);
  }
}

/** Serialize a SPARQL JSON algebra tree to EDN (sparql.core.cljk shape). */
export function algebraToEdn(node) {
  if (!node || typeof node !== 'object') bad('invalid-algebra', 'node must be an object');
  switch (node.op) {
    case 'bgp': {
      const pats = node.patterns.map((p) => `[${p.map(termToEdn).join(' ')}]`).join(' ');
      return `{:sparql/op :bgp :patterns [${pats}]}`;
    }
    case 'filter':
      return `{:sparql/op :filter :expr ${filterToEdn(node.expr)} :pattern ${algebraToEdn(node.pattern)}}`;
    case 'join':
      return `{:sparql/op :join :left ${algebraToEdn(node.left)} :right ${algebraToEdn(node.right)}}`;
    case 'union':
      return `{:sparql/op :union :left ${algebraToEdn(node.left)} :right ${algebraToEdn(node.right)}}`;
    case 'optional':
      return `{:sparql/op :optional :left ${algebraToEdn(node.left)} :right ${algebraToEdn(node.right)}}`;
    case 'project':
      return `{:sparql/op :project :vars [${node.vars.join(' ')}] :pattern ${algebraToEdn(node.pattern)}}`;
    case 'distinct':
      return `{:sparql/op :distinct :pattern ${algebraToEdn(node.pattern)}}`;
    case 'order-by': {
      const vars = node.keys.map((k) => k.var).join(' ');
      const desc = node.keys.filter((k) => k.desc).map((k) => k.var).join(' ');
      return `{:sparql/op :order-by :vars [${vars}] :desc #{${desc}} :pattern ${algebraToEdn(node.pattern)}}`;
    }
    case 'group': {
      const aggs = node.aggregates.map((a) =>
        `{:fn :${a.fn} :arg ${a.arg === '*' ? ':*' : a.arg} :var ${a.var}${a.distinct ? ' :distinct? true' : ''}}`
      ).join(' ');
      return `{:sparql/op :group :by [${node.by.join(' ')}] :aggregates [${aggs}] :pattern ${algebraToEdn(node.pattern)}}`;
    }
    case 'slice': {
      const parts = [':sparql/op :slice'];
      if (node.offset !== undefined) parts.push(`:offset ${node.offset}`);
      if (node.limit !== undefined) parts.push(`:limit ${node.limit}`);
      parts.push(`:pattern ${algebraToEdn(node.pattern)}`);
      return `{${parts.join(' ')}}`;
    }
    default:
      bad('invalid-algebra-op', String(node.op));
  }
}

// Safe recursive-descent EDN parser for algebra interchange
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
    if (depth > 64) bad('edn-too-deep', String(depth));
    skipWs();
    if (i >= n) bad('edn-unexpected-eof');
    const ch = src[i];
    if (ch === '{') {
      i += 1;
      const obj = {};
      skipWs();
      while (i < n && src[i] !== '}') {
        const k = read(depth + 1);
        const v = read(depth + 1);
        obj[String(k)] = v;
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
  if (x && typeof x === 'object' && x[':rdf/type']) {
    const t = String(x[':rdf/type']).replace(/^:/, '');
    if (t === 'iri') return iriTerm(x[':value']);
    if (t === 'bnode') return bnodeTerm(x[':value']);
    if (t === 'literal') return literalTerm(x[':value'], { datatype: x[':datatype'], language: x[':language'] });
  }
  bad('edn-invalid-term', JSON.stringify(x));
}

function ednFilterToJson(x) {
  if (Array.isArray(x)) {
    const tag = String(x[0]).replace(/^:/, '');
    if (tag === 'not') return { kind: 'not', expr: ednFilterToJson(x[1]) };
    if (tag === 'and') return { kind: 'and', left: ednFilterToJson(x[1]), right: ednFilterToJson(x[2]) };
    if (tag === 'or') return { kind: 'or', left: ednFilterToJson(x[1]), right: ednFilterToJson(x[2]) };
    if (tag === 'fn') return { kind: 'fn', fn: String(x[1]).replace(/^:/, '').toUpperCase(), args: x.slice(2).map(ednFilterToJson) };
    if (['=', '!=', '<', '<=', '>', '>='].includes(tag)) {
      return { kind: 'cmp', op: tag, left: ednFilterToJson(x[1]), right: ednFilterToJson(x[2]) };
    }
    bad('edn-invalid-filter', tag);
  }
  return { kind: 'term', value: ednTermToJson(x) };
}

/** Parse an EDN SPARQL algebra string back into our JSON algebra tree. */
export function ednToAlgebra(edn) {
  if (typeof edn !== 'string' || !edn.trim()) bad('edn-empty', 'EDN algebra string required');
  const raw = parseEdnValue(edn);
  function convert(node) {
    if (!node || typeof node !== 'object' || typeof node[':sparql/op'] !== 'string') {
      bad('edn-invalid-algebra', 'missing :sparql/op');
    }
    const op = node[':sparql/op'].replace(/^:/, '');
    switch (op) {
      case 'bgp':
        return { op: 'bgp', patterns: (node[':patterns'] ?? []).map((p) => p.map(ednTermToJson)) };
      case 'filter':
        return { op: 'filter', expr: ednFilterToJson(node[':expr']), pattern: convert(node[':pattern']) };
      case 'join':
      case 'union':
      case 'optional':
        return { op, left: convert(node[':left']), right: convert(node[':right']) };
      case 'project':
        return { op: 'project', vars: (node[':vars'] ?? []).map(String), pattern: convert(node[':pattern']) };
      case 'distinct':
        return { op: 'distinct', pattern: convert(node[':pattern']) };
      case 'order-by': {
        const descSet = new Set((node[':desc']?.$ednSet ?? node[':desc'] ?? []).map(String));
        return {
          op: 'order-by',
          keys: (node[':vars'] ?? []).map((v) => ({ var: String(v), desc: descSet.has(String(v)) })),
          pattern: convert(node[':pattern']),
        };
      }
      case 'group':
        return {
          op: 'group',
          by: (node[':by'] ?? []).map(String),
          aggregates: (node[':aggregates'] ?? []).map((a) => ({
            fn: String(a[':fn']).replace(/^:/, ''),
            arg: a[':arg'] === ':*' ? '*' : String(a[':arg']),
            var: String(a[':var']),
            distinct: Boolean(a[':distinct?']),
          })),
          pattern: convert(node[':pattern']),
        };
      case 'slice':
        return {
          op: 'slice',
          ...(node[':offset'] !== undefined ? { offset: Number(node[':offset']) } : {}),
          ...(node[':limit'] !== undefined ? { limit: Number(node[':limit']) } : {}),
          pattern: convert(node[':pattern']),
        };
      default:
        bad('edn-unsupported-op', op);
    }
  }
  return convert(raw);
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
  if (a.rdfType !== b.rdfType) return a.rdfType.localeCompare(b.rdfType);
  return String(a.value).localeCompare(String(b.value));
}

function safeRegexTest(str, pat) {
  if (pat.length > 128) bad('sparql-regex-too-complex', 'regex pattern exceeds 128 chars');
  // Reject nested quantifiers to guard against catastrophic backtracking (ReDoS).
  if (/(\([^)]*[+*][^)]*\))[+*?]/.test(pat)) bad('sparql-regex-too-complex', 'nested quantifiers refused');
  let re;
  try { re = new RegExp(pat); } catch { bad('sparql-bad-regex', pat); }
  return re.test(str);
}

function evalFilterExpr(expr, binding) {
  switch (expr.kind) {
    case 'term': {
      const t = expr.value;
      if (isLogicVar(t)) return binding[t] ?? null;
      return t;
    }
    case 'not': return !truthyTerm(evalFilterExpr(expr.expr, binding));
    case 'and': return truthyTerm(evalFilterExpr(expr.left, binding)) && truthyTerm(evalFilterExpr(expr.right, binding));
    case 'or': return truthyTerm(evalFilterExpr(expr.left, binding)) || truthyTerm(evalFilterExpr(expr.right, binding));
    case 'cmp': {
      const l = evalFilterExpr(expr.left, binding);
      const r = evalFilterExpr(expr.right, binding);
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
      if (expr.fn === 'BOUND') {
        const arg = expr.args[0];
        if (!arg || arg.kind !== 'term' || !isLogicVar(arg.value)) bad('sparql-syntax-error', 'BOUND expects a ?var');
        return Object.prototype.hasOwnProperty.call(binding, arg.value);
      }
      const vals = expr.args.map((a) => evalFilterExpr(a, binding));
      const v0 = vals[0];
      if (expr.fn === 'ISIRI' || expr.fn === 'ISURI') return v0?.rdfType === 'iri';
      if (expr.fn === 'ISLITERAL') return v0?.rdfType === 'literal';
      if (expr.fn === 'ISBLANK') return v0?.rdfType === 'bnode';
      if (expr.fn === 'STR') return v0 ? literalTerm(String(v0.value)) : null;
      if (expr.fn === 'LANG') return v0?.rdfType === 'literal' ? literalTerm(v0.language ?? '') : literalTerm('');
      if (expr.fn === 'DATATYPE') return v0?.rdfType === 'literal' && v0.datatype ? iriTerm(v0.datatype) : null;
      if (expr.fn === 'LCASE') return v0 ? literalTerm(String(v0.value).toLowerCase()) : null;
      if (expr.fn === 'UCASE') return v0 ? literalTerm(String(v0.value).toUpperCase()) : null;
      if (expr.fn === 'STRLEN') return v0 ? literalTerm(String(v0.value).length) : null;
      if (expr.fn === 'CONTAINS') return Boolean(v0 && vals[1] && String(v0.value).includes(String(vals[1].value)));
      if (expr.fn === 'STRSTARTS') return Boolean(v0 && vals[1] && String(v0.value).startsWith(String(vals[1].value)));
      if (expr.fn === 'STRENDS') return Boolean(v0 && vals[1] && String(v0.value).endsWith(String(vals[1].value)));
      if (expr.fn === 'REGEX') return Boolean(v0 && vals[1] && safeRegexTest(String(v0.value), String(vals[1].value)));
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
    if (Object.prototype.hasOwnProperty.call(binding, pat)) {
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
    if (Object.prototype.hasOwnProperty.call(right, k) && !rdfTermsEqual(v, right[k])) return null;
  }
  return { ...left, ...right };
}

function evalAggregate(agg, rows) {
  const bound = agg.arg === '*' ? rows : rows.filter((r) => Object.prototype.hasOwnProperty.call(r, agg.arg));
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
  if (agg.fn === 'sum') return literalTerm(nums.reduce((a, b) => a + b, 0));
  if (agg.fn === 'min') return literalTerm(Math.min(...nums));
  if (agg.fn === 'max') return literalTerm(Math.max(...nums));
  if (agg.fn === 'avg') return literalTerm(nums.reduce((a, b) => a + b, 0) / nums.length);
  bad('sparql-unsupported-aggregate', agg.fn);
  return null;
}

function evaluateAlgebra(node, quads, state) {
  const tick = (n = 1) => {
    state.steps += n;
    if (state.steps > state.limits.maxScanSteps) {
      bad('scan-limit-exceeded', `exceeded maxScanSteps=${state.limits.maxScanSteps}`);
    }
  };
  const capSolutions = (sols) => {
    if (sols.length > state.limits.maxSolutions * 4) {
      bad('solution-limit-exceeded', `intermediate solutions exceeded cap`);
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
            tick(1);
            const m = matchPattern(pat, q, b);
            if (m) next.push(m);
          }
        }
        current = capSolutions(next);
      }
      return current;
    }
    case 'filter': {
      const rows = evaluateAlgebra(node.pattern, quads, state);
      return rows.filter((b) => truthyTerm(evalFilterExpr(node.expr, b)));
    }
    case 'join': {
      const lefts = evaluateAlgebra(node.left, quads, state);
      const rights = evaluateAlgebra(node.right, quads, state);
      const out = [];
      for (const l of lefts) {
        for (const r of rights) {
          tick(1);
          const merged = compatibleMerge(l, r);
          if (merged) out.push(merged);
        }
      }
      return capSolutions(out);
    }
    case 'union': {
      const lefts = evaluateAlgebra(node.left, quads, state);
      const rights = evaluateAlgebra(node.right, quads, state);
      return capSolutions([...lefts, ...rights]);
    }
    case 'optional': {
      const lefts = evaluateAlgebra(node.left, quads, state);
      const rights = evaluateAlgebra(node.right, quads, state);
      const out = [];
      for (const l of lefts) {
        let matched = false;
        for (const r of rights) {
          tick(1);
          const merged = compatibleMerge(l, r);
          if (merged) { out.push(merged); matched = true; }
        }
        if (!matched) out.push(l);
      }
      return capSolutions(out);
    }
    case 'group': {
      const rows = evaluateAlgebra(node.pattern, quads, state);
      const groups = new Map();
      if (node.by && node.by.length > 0) {
        for (const r of rows) {
          const keyObj = {};
          const keyParts = [];
          for (const v of node.by) {
            if (Object.prototype.hasOwnProperty.call(r, v)) {
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
      const rows = evaluateAlgebra(node.pattern, quads, state);
      return rows.map((r) => {
        const p = {};
        for (const v of node.vars) {
          if (Object.prototype.hasOwnProperty.call(r, v)) p[v] = r[v];
        }
        return p;
      });
    }
    case 'distinct': {
      const rows = evaluateAlgebra(node.pattern, quads, state);
      const seen = new Set();
      return rows.filter((r) => {
        const k = Object.keys(r).sort().map((v) => `${v}=${rdfTermKey(r[v])}`).join('&');
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    case 'order-by': {
      const rows = [...evaluateAlgebra(node.pattern, quads, state)];
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
      let rows = evaluateAlgebra(node.pattern, quads, state);
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
  const limits = { ...DEFAULT_SPARQL_LIMITS, ...opts.limits };
  if (opts.maxScanSteps !== undefined) limits.maxScanSteps = opts.maxScanSteps;
  if (opts.maxSolutions !== undefined) limits.maxSolutions = opts.maxSolutions;
  if (opts.maxOutputBytes !== undefined) limits.maxOutputBytes = opts.maxOutputBytes;

  let parsed;
  if (typeof queryOrAlgebra === 'string') {
    parsed = parseSparql(queryOrAlgebra, { maxQueryBytes: limits.maxQueryBytes });
  } else if (queryOrAlgebra && typeof queryOrAlgebra === 'object' && typeof queryOrAlgebra.edn === 'string') {
    const algebra = ednToAlgebra(queryOrAlgebra.edn);
    parsed = { form: queryOrAlgebra.form ?? 'select', prefixes: {}, algebra, projectedVars: [], selectStar: true };
  } else if (queryOrAlgebra && typeof queryOrAlgebra === 'object' && typeof queryOrAlgebra.op === 'string') {
    parsed = { form: opts.form ?? 'select', prefixes: {}, algebra: queryOrAlgebra, projectedVars: [], selectStar: true };
  } else {
    bad('invalid-sparql-input', 'expected SPARQL string, JSON algebra, or { edn }');
  }

  // Visibility filter over quads (subject-level provenance/jurisdiction policy + explicit predicate)
  const visible = buildVisibilityFilter(opts);
  const subjectMeta = new Map();
  if (Array.isArray(snapshot.facts) && (opts.jurisdiction || opts.allowedSources)) {
    const baseIri = snapshot.baseIri ?? DEFAULT_BASE_IRI;
    for (const f of snapshot.facts) {
      const typeId = f['ontology/type'];
      const iri = f.iri ?? `${baseIri}entity/${encodeURIComponent(typeId)}/${encodeURIComponent(String(f.id))}`;
      subjectMeta.set(iri, f);
    }
  }
  const visibleQuads = snapshot.quads.filter((q) => {
    const meta = subjectMeta.get(q.subject.value);
    if (meta && !visible(meta)) return false;
    return visible(q);
  });

  const state = { steps: 0, limits };
  const rawSolutions = evaluateAlgebra(parsed.algebra, visibleQuads, state);
  const algebraEdn = algebraToEdn(parsed.algebra);

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
        if (!seen.has(key)) seen.set(key, { subject: rs, predicate: rp, object: ro });
      }
    }
    const graph = [...seen.values()];
    if (graph.length > limits.maxSolutions) bad('solution-limit-exceeded', `CONSTRUCT produced ${graph.length} triples`);
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
    const described = visibleQuads.filter((q) => wanted.has(rdfTermKey(q.subject)));
    if (described.length > limits.maxSolutions) bad('solution-limit-exceeded', `DESCRIBE produced ${described.length} quads`);
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
