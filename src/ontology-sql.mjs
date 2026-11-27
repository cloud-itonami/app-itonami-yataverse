// Bounded, read-only, basis-pinned SQL subset parser and evaluator over an OntologySnapshot.
//
// Supported grammar (fail-closed on everything else):
//   SELECT [DISTINCT] <select_item> (, <select_item>)*
//   FROM <table> [[AS] <alias>]
//   [(INNER | LEFT [OUTER]) JOIN <table> [[AS] <alias>] ON <expr>]*
//   [WHERE <expr>]
//   [GROUP BY <col_ref> (, <col_ref>)*]
//   [HAVING <expr>]
//   [ORDER BY <expr> [ASC | DESC] (, ...)*]
//   [LIMIT <int> [OFFSET <int>]]
//   [;]
//
// Refuses: INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, TRUNCATE, REPLACE, MERGE,
// GRANT, REVOKE, PRAGMA, ATTACH, EXEC, WITH, UNION, subqueries, multiple statements,
// arbitrary functions, and scans/results exceeding configured bounds.

import { buildVisibilityFilter } from './ontology.mjs';

export const DEFAULT_SQL_LIMITS = Object.freeze({
  maxQueryBytes: 16 * 1024,
  maxScanRows: 50_000,
  maxResultRows: 1_000,
  maxOutputBytes: 512 * 1024,
});

const WRITE_OR_DDL_KEYWORDS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'REPLACE',
  'MERGE', 'GRANT', 'REVOKE', 'EXEC', 'EXECUTE', 'ATTACH', 'DETACH', 'PRAGMA',
  'COPY', 'CALL', 'VACUUM', 'REINDEX', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT',
]);

const UNSUPPORTED_CLAUSE_KEYWORDS = new Set([
  'WITH', 'UNION', 'INTERSECT', 'EXCEPT', 'WINDOW', 'OVER', 'INTO', 'FOR', 'EXPLAIN', 'FETCH',
]);

const AGGREGATE_FUNCS = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);
const SCALAR_FUNCS = new Set(['LOWER', 'UPPER', 'LENGTH', 'COALESCE']);

export class SqlError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'SqlError';
    this.code = code;
    this.detail = detail ?? null;
  }
}

const bad = (code, detail) => { throw new SqlError(code, detail); };

// --- Tokenizer ---

function tokenize(sql) {
  const tokens = [];
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    // Line comments -- ...
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i += 1;
      continue;
    }
    // Block comments /* ... */
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) bad('sql-syntax-error', 'unterminated block comment');
      i = end + 2;
      continue;
    }
    // Single-quoted string literal
    if (ch === "'") {
      let val = '';
      i += 1;
      let closed = false;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { val += "'"; i += 2; continue; }
          i += 1; closed = true; break;
        }
        val += sql[i++];
      }
      if (!closed) bad('sql-syntax-error', 'unterminated string literal');
      tokens.push({ type: 'string', value: val });
      continue;
    }
    // Double-quoted identifier
    if (ch === '"') {
      let val = '';
      i += 1;
      let closed = false;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') { val += '"'; i += 2; continue; }
          i += 1; closed = true; break;
        }
        val += sql[i++];
      }
      if (!closed || !val) bad('sql-syntax-error', 'invalid quoted identifier');
      tokens.push({ type: 'ident', value: val, quoted: true });
      continue;
    }
    // Number literal
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      let start = i;
      let sawDot = false;
      while (i < n && (/[0-9]/.test(sql[i]) || (!sawDot && sql[i] === '.'))) {
        if (sql[i] === '.') sawDot = true;
        i += 1;
      }
      const raw = sql.slice(start, i);
      const num = Number(raw);
      if (!Number.isFinite(num)) bad('sql-syntax-error', `bad number ${raw}`);
      tokens.push({ type: 'number', value: num });
      continue;
    }
    // Multi-char operators
    const two = sql.slice(i, i + 2);
    if (two === '!=' || two === '<>' || two === '<=' || two === '>=') {
      tokens.push({ type: 'op', value: two === '<>' ? '!=' : two });
      i += 2;
      continue;
    }
    // Single-char operators & punctuation
    if ('=<>+-*/(),.;'.includes(ch)) {
      tokens.push({ type: 'punc', value: ch });
      i += 1;
      continue;
    }
    // Identifier / keyword
    if (/[a-zA-Z_]/.test(ch)) {
      let start = i;
      while (i < n && /[a-zA-Z0-9_]/.test(sql[i])) i += 1;
      const word = sql.slice(start, i);
      tokens.push({ type: 'word', value: word, upper: word.toUpperCase() });
      continue;
    }
    bad('sql-syntax-error', `unexpected character "${ch}" at position ${i}`);
  }
  tokens.push({ type: 'eof', value: null });
  return tokens;
}

// --- Parser ---

export function parseSql(sql, { maxQueryBytes = DEFAULT_SQL_LIMITS.maxQueryBytes } = {}) {
  if (typeof sql !== 'string' || !sql.trim()) bad('sql-empty', 'SQL query must be a non-empty string');
  if (Buffer.byteLength(sql, 'utf8') > maxQueryBytes) {
    bad('sql-query-too-large', `exceeds ${maxQueryBytes} bytes`);
  }
  const tokens = tokenize(sql);
  let pos = 0;

  const peek = (offset = 0) => tokens[pos + offset] ?? { type: 'eof', value: null };
  const next = () => tokens[pos++];
  const isWord = (kw, offset = 0) => {
    const t = peek(offset);
    return t.type === 'word' && t.upper === kw;
  };
  const isPunc = (ch, offset = 0) => {
    const t = peek(offset);
    return (t.type === 'punc' || t.type === 'op') && t.value === ch;
  };
  const eatWord = (kw) => { if (isWord(kw)) { next(); return true; } return false; };
  const expectWord = (kw) => {
    if (!isWord(kw)) bad('sql-syntax-error', `expected ${kw}, got ${peek().value ?? 'EOF'}`);
    return next();
  };
  const expectPunc = (ch) => {
    if (!isPunc(ch)) bad('sql-syntax-error', `expected "${ch}", got ${peek().value ?? 'EOF'}`);
    return next();
  };

  // Leading verb check (fail closed on writes/DDL/unsupported statements)
  const first = peek();
  if (first.type === 'word' && WRITE_OR_DDL_KEYWORDS.has(first.upper)) {
    bad('sql-write-refused', `${first.upper} statements are forbidden (read-only engine)`);
  }
  if (first.type === 'word' && UNSUPPORTED_CLAUSE_KEYWORDS.has(first.upper)) {
    bad('sql-unsupported-construct', `${first.upper} is not supported`);
  }
  if (!eatWord('SELECT')) {
    bad('sql-unsupported-construct', `only SELECT queries are supported (got ${first.value ?? 'EOF'})`);
  }

  const RESERVED_ALIAS = new Set([
    'FROM', 'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER',
    'ON', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'ASC', 'DESC', 'UNION',
    'INTERSECT', 'EXCEPT', 'INTO', 'SET', 'VALUES',
  ]);

  function parseIdent() {
    const t = peek();
    if (t.type === 'ident' || t.type === 'word') { next(); return t.value; }
    bad('sql-syntax-error', `expected identifier, got ${t.value ?? 'EOF'}`);
  }

  function parseOptionalAlias() {
    if (eatWord('AS')) return parseIdent();
    const t = peek();
    if (t.type === 'ident') { next(); return t.value; }
    if (t.type === 'word' && !RESERVED_ALIAS.has(t.upper)) { next(); return t.value; }
    return null;
  }

  function parsePrimary() {
    const t = peek();
    if (t.type === 'number') { next(); return { kind: 'literal', value: t.value }; }
    if (t.type === 'string') { next(); return { kind: 'literal', value: t.value }; }
    if (t.type === 'word' && t.upper === 'TRUE') { next(); return { kind: 'literal', value: true }; }
    if (t.type === 'word' && t.upper === 'FALSE') { next(); return { kind: 'literal', value: false }; }
    if (t.type === 'word' && t.upper === 'NULL') { next(); return { kind: 'literal', value: null }; }
    if (isPunc('(')) {
      next();
      if (isWord('SELECT')) bad('sql-unsupported-construct', 'subqueries are not supported');
      const e = parseOr();
      expectPunc(')');
      return e;
    }
    if (isPunc('*')) { next(); return { kind: 'star', table: null }; }
    if (t.type === 'word' || t.type === 'ident') {
      // Function call?
      if (t.type === 'word' && isPunc('(', 1)) {
        const fn = t.upper;
        next(); // name
        expectPunc('(');
        if (AGGREGATE_FUNCS.has(fn)) {
          const distinct = eatWord('DISTINCT');
          let arg;
          if (isPunc('*')) {
            if (fn !== 'COUNT') bad('sql-syntax-error', `${fn}(*) is not valid`);
            next();
            arg = { kind: 'star', table: null };
          } else {
            arg = parseAddSub();
          }
          expectPunc(')');
          if (isWord('OVER')) bad('sql-unsupported-construct', 'window functions (OVER) are not supported');
          return { kind: 'agg', fn, distinct, arg };
        }
        if (SCALAR_FUNCS.has(fn)) {
          const args = [];
          if (!isPunc(')')) {
            do { args.push(parseAddSub()); } while (isPunc(',') && next());
          }
          expectPunc(')');
          return { kind: 'call', fn, args };
        }
        bad('sql-unsupported-function', `function "${t.value}" is not allowlisted`);
      }
      const firstPart = parseIdent();
      if (isPunc('.')) {
        next();
        if (isPunc('*')) { next(); return { kind: 'star', table: firstPart }; }
        const col = parseIdent();
        return { kind: 'column', table: firstPart, column: col };
      }
      return { kind: 'column', table: null, column: firstPart };
    }
    bad('sql-syntax-error', `unexpected token "${t.value ?? 'EOF'}" in expression`);
  }

  function parseUnary() {
    if (isPunc('-')) { next(); return { kind: 'unary', op: '-', expr: parseUnary() }; }
    if (isPunc('+')) { next(); return parseUnary(); }
    return parsePrimary();
  }

  function parseMulDiv() {
    let left = parseUnary();
    while (isPunc('*') || isPunc('/')) {
      const op = next().value;
      left = { kind: 'binary', op, left, right: parseUnary() };
    }
    return left;
  }

  function parseAddSub() {
    let left = parseMulDiv();
    while (isPunc('+') || isPunc('-')) {
      const op = next().value;
      left = { kind: 'binary', op, left, right: parseMulDiv() };
    }
    return left;
  }

  function parseComparison() {
    const left = parseAddSub();
    if (eatWord('IS')) {
      const negated = eatWord('NOT');
      expectWord('NULL');
      return { kind: 'is_null', expr: left, negated };
    }
    const negated = eatWord('NOT');
    if (eatWord('IN')) {
      expectPunc('(');
      if (isWord('SELECT')) bad('sql-unsupported-construct', 'IN (SELECT ...) subqueries are not supported');
      const items = [];
      do { items.push(parseAddSub()); } while (isPunc(',') && next());
      expectPunc(')');
      return { kind: 'in', expr: left, items, negated };
    }
    if (eatWord('LIKE')) {
      const pattern = parseAddSub();
      return { kind: 'like', expr: left, pattern, negated };
    }
    if (eatWord('BETWEEN')) {
      const low = parseAddSub();
      expectWord('AND');
      const high = parseAddSub();
      return { kind: 'between', expr: left, low, high, negated };
    }
    if (negated) bad('sql-syntax-error', 'unexpected NOT after expression');

    const t = peek();
    if ((t.type === 'punc' && (t.value === '=' || t.value === '<' || t.value === '>')) || t.type === 'op') {
      const op = next().value;
      return { kind: 'binary', op, left, right: parseAddSub() };
    }
    return left;
  }

  function parseNot() {
    if (eatWord('NOT')) return { kind: 'not', expr: parseNot() };
    return parseComparison();
  }

  function parseAnd() {
    let left = parseNot();
    while (eatWord('AND')) left = { kind: 'binary', op: 'AND', left, right: parseNot() };
    return left;
  }

  function parseOr() {
    let left = parseAnd();
    while (eatWord('OR')) left = { kind: 'binary', op: 'OR', left, right: parseAnd() };
    return left;
  }

  const distinct = eatWord('DISTINCT');

  // SELECT list
  const select = [];
  do {
    const expr = parseAddSub();
    if (expr.kind === 'star') {
      select.push({ expr, alias: null });
    } else {
      const alias = parseOptionalAlias();
      select.push({ expr, alias });
    }
  } while (isPunc(',') && next());

  if (isWord('INTO')) bad('sql-write-refused', 'SELECT INTO is forbidden');

  // FROM clause
  expectWord('FROM');
  if (isPunc('(')) bad('sql-unsupported-construct', 'subqueries in FROM are not supported');
  const fromTable = parseIdent();
  const fromAlias = parseOptionalAlias() ?? fromTable;
  const from = { table: fromTable, alias: fromAlias };

  // JOIN clauses
  const joins = [];
  for (;;) {
    let joinKind = null;
    if (eatWord('JOIN')) joinKind = 'inner';
    else if (eatWord('INNER')) { expectWord('JOIN'); joinKind = 'inner'; }
    else if (eatWord('LEFT')) { eatWord('OUTER'); expectWord('JOIN'); joinKind = 'left'; }
    else if (isWord('RIGHT') || isWord('FULL') || isWord('CROSS')) {
      bad('sql-unsupported-construct', `${peek().upper} JOIN is not supported (use INNER or LEFT JOIN)`);
    } else {
      break;
    }
    if (isPunc('(')) bad('sql-unsupported-construct', 'subqueries in JOIN are not supported');
    const table = parseIdent();
    const alias = parseOptionalAlias() ?? table;
    expectWord('ON');
    const on = parseOr();
    joins.push({ kind: joinKind, table, alias, on });
  }

  // WHERE
  let where = null;
  if (eatWord('WHERE')) where = parseOr();

  // GROUP BY
  let groupBy = null;
  if (eatWord('GROUP')) {
    expectWord('BY');
    groupBy = [];
    do { groupBy.push(parseAddSub()); } while (isPunc(',') && next());
  }

  // HAVING
  let having = null;
  if (eatWord('HAVING')) having = parseOr();

  // ORDER BY
  let orderBy = null;
  if (eatWord('ORDER')) {
    expectWord('BY');
    orderBy = [];
    do {
      const expr = parseAddSub();
      let dir = 'ASC';
      if (eatWord('DESC')) dir = 'DESC';
      else eatWord('ASC');
      orderBy.push({ expr, dir });
    } while (isPunc(',') && next());
  }

  // LIMIT / OFFSET
  let limit = null;
  let offset = 0;
  if (eatWord('LIMIT')) {
    const t = next();
    if (t.type !== 'number' || !Number.isInteger(t.value) || t.value < 0) {
      bad('sql-syntax-error', 'LIMIT requires a non-negative integer');
    }
    limit = t.value;
    if (eatWord('OFFSET')) {
      const o = next();
      if (o.type !== 'number' || !Number.isInteger(o.value) || o.value < 0) {
        bad('sql-syntax-error', 'OFFSET requires a non-negative integer');
      }
      offset = o.value;
    }
  } else if (eatWord('OFFSET')) {
    const o = next();
    if (o.type !== 'number' || !Number.isInteger(o.value) || o.value < 0) {
      bad('sql-syntax-error', 'OFFSET requires a non-negative integer');
    }
    offset = o.value;
  }

  // Trailing semicolon allowed only at EOF (reject stacked statements)
  if (isPunc(';')) next();
  if (peek().type !== 'eof') {
    const rem = peek();
    if (rem.type === 'word' && WRITE_OR_DDL_KEYWORDS.has(rem.upper)) {
      bad('sql-write-refused', `multiple/write statement "${rem.upper}" is forbidden`);
    }
    if (rem.type === 'word' && UNSUPPORTED_CLAUSE_KEYWORDS.has(rem.upper)) {
      bad('sql-unsupported-construct', `${rem.upper} is not supported`);
    }
    bad('sql-syntax-error', `unexpected trailing token "${rem.value}"`);
  }

  return { distinct, select, from, joins, where, groupBy, having, orderBy, limit, offset };
}

// --- Evaluator ---

function hasAggregate(expr) {
  if (!expr) return false;
  if (expr.kind === 'agg') return true;
  if (expr.kind === 'binary') return hasAggregate(expr.left) || hasAggregate(expr.right);
  if (expr.kind === 'unary' || expr.kind === 'not' || expr.kind === 'is_null') return hasAggregate(expr.expr);
  if (expr.kind === 'call') return expr.args.some(hasAggregate);
  if (expr.kind === 'in') return hasAggregate(expr.expr) || expr.items.some(hasAggregate);
  if (expr.kind === 'like') return hasAggregate(expr.expr) || hasAggregate(expr.pattern);
  if (expr.kind === 'between') return hasAggregate(expr.expr) || hasAggregate(expr.low) || hasAggregate(expr.high);
  return false;
}

function defaultColName(expr, index) {
  if (expr.kind === 'column') return expr.column;
  if (expr.kind === 'agg') {
    const inner = expr.arg.kind === 'star' ? 'all' : (expr.arg.kind === 'column' ? expr.arg.column : `expr${index}`);
    return `${expr.fn.toLowerCase()}_${inner}`;
  }
  return `col_${index + 1}`;
}

function compareValues(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0);
  const na = typeof a === 'number' ? a : (typeof a === 'string' && /^-?\d+(\.\d+)?$/.test(a.trim()) ? Number(a) : NaN);
  const nb = typeof b === 'number' ? b : (typeof b === 'string' && /^-?\d+(\.\d+)?$/.test(b.trim()) ? Number(b) : NaN);
  if (Number.isFinite(na) && Number.isFinite(nb) && typeof a !== typeof b) return na - nb;
  return String(a).localeCompare(String(b));
}

function likeMatch(value, pattern) {
  if (value === null || value === undefined || pattern === null || pattern === undefined) return false;
  const s = String(value);
  const p = String(pattern);
  // Bounded wildcard DP (avoids ReDoS from converting SQL LIKE to arbitrary regex)
  let si = 0, pi = 0, starIdx = -1, matchIdx = 0;
  while (si < s.length) {
    if (pi < p.length && (p[pi] === '_' || p[pi] === s[si])) { si += 1; pi += 1; }
    else if (pi < p.length && p[pi] === '%') { starIdx = pi++; matchIdx = si; }
    else if (starIdx !== -1) { pi = starIdx + 1; si = ++matchIdx; }
    else return false;
  }
  while (pi < p.length && p[pi] === '%') pi += 1;
  return pi === p.length;
}

function lookupColumn(rowCtx, table, column) {
  const colLower = column.toLowerCase();
  if (table) {
    const tObj = rowCtx.byAlias.get(table.toLowerCase());
    if (!tObj) bad('sql-unknown-table-alias', table);
    for (const [k, v] of Object.entries(tObj)) {
      if (k.toLowerCase() === colLower) return v;
    }
    return null;
  }
  if (rowCtx.projected && Object.prototype.hasOwnProperty.call(rowCtx.projected, column)) {
    return rowCtx.projected[column];
  }
  let found = false;
  let value = null;
  for (const tObj of rowCtx.byAlias.values()) {
    if (!tObj) continue;
    for (const [k, v] of Object.entries(tObj)) {
      if (k.toLowerCase() === colLower) {
        if (found) bad('sql-ambiguous-column', column);
        found = true;
        value = v;
      }
    }
  }
  return value;
}

function evalExpr(expr, rowCtx, groupRows = null) {
  switch (expr.kind) {
    case 'literal': return expr.value;
    case 'column': return lookupColumn(rowCtx, expr.table, expr.column);
    case 'unary': {
      const v = evalExpr(expr.expr, rowCtx, groupRows);
      if (v === null || v === undefined) return null;
      return -Number(v);
    }
    case 'not': return !evalExpr(expr.expr, rowCtx, groupRows);
    case 'is_null': {
      const v = evalExpr(expr.expr, rowCtx, groupRows);
      const isNull = v === null || v === undefined;
      return expr.negated ? !isNull : isNull;
    }
    case 'in': {
      const v = evalExpr(expr.expr, rowCtx, groupRows);
      const matched = expr.items.some((item) => {
        const iv = evalExpr(item, rowCtx, groupRows);
        return v !== null && iv !== null && compareValues(v, iv) === 0;
      });
      return expr.negated ? !matched : matched;
    }
    case 'like': {
      const v = evalExpr(expr.expr, rowCtx, groupRows);
      const p = evalExpr(expr.pattern, rowCtx, groupRows);
      const matched = likeMatch(v, p);
      return expr.negated ? !matched : matched;
    }
    case 'between': {
      const v = evalExpr(expr.expr, rowCtx, groupRows);
      const lo = evalExpr(expr.low, rowCtx, groupRows);
      const hi = evalExpr(expr.high, rowCtx, groupRows);
      const matched = v !== null && lo !== null && hi !== null
        && compareValues(v, lo) >= 0 && compareValues(v, hi) <= 0;
      return expr.negated ? !matched : matched;
    }
    case 'call': {
      const vals = expr.args.map((a) => evalExpr(a, rowCtx, groupRows));
      if (expr.fn === 'LOWER') return vals[0] == null ? null : String(vals[0]).toLowerCase();
      if (expr.fn === 'UPPER') return vals[0] == null ? null : String(vals[0]).toUpperCase();
      if (expr.fn === 'LENGTH') return vals[0] == null ? null : String(vals[0]).length;
      if (expr.fn === 'COALESCE') {
        for (const v of vals) if (v !== null && v !== undefined) return v;
        return null;
      }
      bad('sql-unsupported-function', expr.fn);
      return null;
    }
    case 'agg': {
      if (!groupRows) bad('sql-aggregate-not-allowed-here', expr.fn);
      if (expr.fn === 'COUNT' && expr.arg.kind === 'star') return groupRows.length;
      let vals = groupRows
        .map((r) => evalExpr(expr.arg, r, null))
        .filter((v) => v !== null && v !== undefined);
      if (expr.distinct) {
        const seen = new Set();
        vals = vals.filter((v) => {
          const k = `${typeof v}:${String(v)}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      }
      if (expr.fn === 'COUNT') return vals.length;
      if (vals.length === 0) return null;
      if (expr.fn === 'MIN') return vals.reduce((a, b) => (compareValues(a, b) <= 0 ? a : b));
      if (expr.fn === 'MAX') return vals.reduce((a, b) => (compareValues(a, b) >= 0 ? a : b));
      const nums = vals.map(Number).filter(Number.isFinite);
      if (nums.length === 0) return null;
      const sum = nums.reduce((a, b) => a + b, 0);
      if (expr.fn === 'SUM') return sum;
      if (expr.fn === 'AVG') return sum / nums.length;
      bad('sql-unsupported-function', expr.fn);
      return null;
    }
    case 'binary': {
      if (expr.op === 'AND') return Boolean(evalExpr(expr.left, rowCtx, groupRows)) && Boolean(evalExpr(expr.right, rowCtx, groupRows));
      if (expr.op === 'OR') return Boolean(evalExpr(expr.left, rowCtx, groupRows)) || Boolean(evalExpr(expr.right, rowCtx, groupRows));
      const l = evalExpr(expr.left, rowCtx, groupRows);
      const r = evalExpr(expr.right, rowCtx, groupRows);
      if (expr.op === '+' || expr.op === '-' || expr.op === '*' || expr.op === '/') {
        if (l === null || r === null) return null;
        const ln = Number(l), rn = Number(r);
        if (!Number.isFinite(ln) || !Number.isFinite(rn)) return null;
        if (expr.op === '+') return ln + rn;
        if (expr.op === '-') return ln - rn;
        if (expr.op === '*') return ln * rn;
        return rn === 0 ? null : ln / rn;
      }
      if (l === null || r === null || l === undefined || r === undefined) return false;
      const cmp = compareValues(l, r);
      if (expr.op === '=') return cmp === 0;
      if (expr.op === '!=') return cmp !== 0;
      if (expr.op === '<') return cmp < 0;
      if (expr.op === '<=') return cmp <= 0;
      if (expr.op === '>') return cmp > 0;
      if (expr.op === '>=') return cmp >= 0;
      bad('sql-unsupported-operator', expr.op);
      return false;
    }
    default:
      bad('sql-unsupported-expression', expr.kind);
      return null;
  }
}

/**
 * Execute a read-only SQL query against a pinned OntologySnapshot.
 * Enforces basisCid equality (when provided), optional visibility filter, and scan/result/output limits.
 */
export function executeSql(snapshot, sql, opts = {}) {
  if (!snapshot || !(snapshot.tables instanceof Map)) bad('invalid-snapshot', 'verified OntologySnapshot required');
  if (opts.basisCid && snapshot.basisCid !== opts.basisCid) {
    bad('basis-cid-mismatch', `expected ${opts.basisCid}, got ${snapshot.basisCid}`);
  }
  const limits = { ...DEFAULT_SQL_LIMITS, ...opts.limits };
  if (opts.maxScanRows !== undefined) limits.maxScanRows = opts.maxScanRows;
  if (opts.maxResultRows !== undefined) limits.maxResultRows = opts.maxResultRows;
  if (opts.maxOutputBytes !== undefined) limits.maxOutputBytes = opts.maxOutputBytes;

  const ast = parseSql(sql, { maxQueryBytes: limits.maxQueryBytes });
  const visible = buildVisibilityFilter(opts);

  const loadTable = (tableName) => {
    const t = snapshot.tables.get(tableName.toLowerCase());
    if (!t) bad('sql-unknown-table', `${tableName} (available: ${[...snapshot.tables.keys()].join(', ')})`);
    return t.rows;
  };

  let scannedRows = 0;
  const tickScan = (n = 1) => {
    scannedRows += n;
    if (scannedRows > limits.maxScanRows) {
      bad('scan-limit-exceeded', `exceeded maxScanRows=${limits.maxScanRows}`);
    }
  };

  // Scan base FROM table with visibility filter
  const baseRows = loadTable(ast.from.table);
  let working = [];
  const baseAlias = ast.from.alias.toLowerCase();
  for (const r of baseRows) {
    tickScan(1);
    if (!visible(r)) continue;
    const byAlias = new Map([[baseAlias, r]]);
    working.push({ byAlias });
  }

  // Execute JOINs sequentially (bounded)
  for (const j of ast.joins) {
    const rightRows = loadTable(j.table);
    const rightAlias = j.alias.toLowerCase();
    const visibleRight = [];
    for (const r of rightRows) {
      tickScan(1);
      if (visible(r)) visibleRight.push(r);
    }
    const nextWorking = [];
    for (const leftCtx of working) {
      let matched = false;
      for (const rr of visibleRight) {
        tickScan(1);
        const merged = new Map(leftCtx.byAlias);
        merged.set(rightAlias, rr);
        const candidate = { byAlias: merged };
        if (evalExpr(j.on, candidate)) {
          nextWorking.push(candidate);
          matched = true;
        }
      }
      if (!matched && j.kind === 'left') {
        const merged = new Map(leftCtx.byAlias);
        merged.set(rightAlias, {});
        nextWorking.push({ byAlias: merged });
      }
    }
    working = nextWorking;
  }

  // WHERE
  if (ast.where) {
    working = working.filter((ctx) => Boolean(evalExpr(ast.where, ctx)));
  }

  // Determine if aggregate query
  const isAggregate = Boolean(ast.groupBy) || ast.select.some((s) => hasAggregate(s.expr)) || hasAggregate(ast.having);

  let outputEntries = []; // [{ projected, ctx, groupRows }]
  let columns = [];

  if (isAggregate) {
    const groups = new Map();
    if (ast.groupBy && ast.groupBy.length > 0) {
      for (const ctx of working) {
        const keyVals = ast.groupBy.map((g) => evalExpr(g, ctx));
        const keyStr = JSON.stringify(keyVals);
        let bucket = groups.get(keyStr);
        if (!bucket) { bucket = []; groups.set(keyStr, bucket); }
        bucket.push(ctx);
      }
    } else {
      // Whole-table aggregate: always yields 1 group (even when working is empty)
      groups.set('__all__', working);
    }

    for (const groupRows of groups.values()) {
      const sampleCtx = groupRows[0] ?? { byAlias: new Map([[baseAlias, {}]]) };
      if (ast.having && !evalExpr(ast.having, sampleCtx, groupRows)) continue;
      const projected = {};
      const cols = [];
      for (let i = 0; i < ast.select.length; i++) {
        const item = ast.select[i];
        if (item.expr.kind === 'star') bad('sql-syntax-error', 'SELECT * cannot be combined with GROUP BY / aggregates');
        const colName = item.alias ?? defaultColName(item.expr, i);
        projected[colName] = evalExpr(item.expr, sampleCtx, groupRows);
        cols.push(colName);
      }
      if (columns.length === 0) columns = cols;
      outputEntries.push({ projected, ctx: { ...sampleCtx, projected }, groupRows });
    }
  } else {
    const colSet = new Set();
    for (const ctx of working) {
      const projected = {};
      for (let i = 0; i < ast.select.length; i++) {
        const item = ast.select[i];
        if (item.expr.kind === 'star') {
          if (item.expr.table) {
            const tObj = ctx.byAlias.get(item.expr.table.toLowerCase());
            if (!tObj) bad('sql-unknown-table-alias', item.expr.table);
            for (const [k, v] of Object.entries(tObj)) { projected[k] = v; colSet.add(k); }
          } else {
            for (const [alias, tObj] of ctx.byAlias.entries()) {
              for (const [k, v] of Object.entries(tObj)) {
                const key = ctx.byAlias.size > 1 && Object.prototype.hasOwnProperty.call(projected, k)
                  ? `${alias}_${k}` : k;
                projected[key] = v;
                colSet.add(key);
              }
            }
          }
        } else {
          const colName = item.alias ?? defaultColName(item.expr, i);
          projected[colName] = evalExpr(item.expr, ctx);
          colSet.add(colName);
        }
      }
      outputEntries.push({ projected, ctx: { ...ctx, projected }, groupRows: null });
    }
    columns = [...colSet];
  }

  // DISTINCT
  if (ast.distinct) {
    const seen = new Set();
    outputEntries = outputEntries.filter((entry) => {
      const k = JSON.stringify(entry.projected);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  // ORDER BY
  if (ast.orderBy && ast.orderBy.length > 0) {
    outputEntries.sort((a, b) => {
      for (const spec of ast.orderBy) {
        const va = evalExpr(spec.expr, a.ctx, a.groupRows);
        const vb = evalExpr(spec.expr, b.ctx, b.groupRows);
        const c = compareValues(va, vb);
        if (c !== 0) return spec.dir === 'DESC' ? -c : c;
      }
      return 0;
    });
  }

  // OFFSET & LIMIT + maxResultRows enforcement
  const sliced = ast.offset > 0 ? outputEntries.slice(ast.offset) : outputEntries;
  const limited = ast.limit !== null ? sliced.slice(0, ast.limit) : sliced;
  if (limited.length > limits.maxResultRows) {
    bad('result-limit-exceeded', `result has ${limited.length} rows (maxResultRows=${limits.maxResultRows}; add LIMIT)`);
  }
  const rows = limited.map((e) => e.projected);

  const outputBytes = Buffer.byteLength(JSON.stringify(rows), 'utf8');
  if (outputBytes > limits.maxOutputBytes) {
    bad('output-size-exceeded', `result size ${outputBytes} exceeds maxOutputBytes=${limits.maxOutputBytes}`);
  }

  return {
    basisCid: snapshot.basisCid,
    query: sql,
    columns,
    rows,
    rowCount: rows.length,
    scannedRows,
    readOnly: true,
    limits,
  };
}
