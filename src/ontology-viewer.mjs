// Semantic UI / noun.verb operation contract and read-only Ontology Viewer (JSON, SVG, HTML).
//
// Design constraints:
// - Strictly Semantic UI / noun.verb operations with machine-readable input/output schemas:
//   ontology.build, ontology.verify, ontology.inspect, ontology.query_sql,
//   ontology.query_sparql, ontology.view.
// - Zero external UI frameworks; pure semantic HTML5 + minimal custom CSS.
// - Read-only, basisCid-pinned, bounded, XSS-safe (all untrusted text escaped).

import {
  ONTOLOGY_SNAPSHOT_SCHEMA,
  OntologyError,
  buildOntologySnapshot,
  verifyOntologySnapshot,
  normalizeKeyword,
} from './ontology.mjs';
import { executeSql } from './ontology-sql.mjs';
import { executeSparql } from './ontology-sparql.mjs';

export const ONTOLOGY_OPERATION_SCHEMA_VERSION = 'yataverse.ontology.operations/v1';
export const NOUN_VERB_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

const BASIS_CID_PROP = { type: 'string', description: 'Pinned CIDv1 (dag-cbor, sha2-256) root of the ontology snapshot.' };
const LIMITS_PROP = {
  type: 'object',
  description: 'Optional execution bounds.',
  properties: {
    maxScanRows: { type: 'integer', minimum: 1 },
    maxScanSteps: { type: 'integer', minimum: 1 },
    maxResultRows: { type: 'integer', minimum: 1 },
    maxSolutions: { type: 'integer', minimum: 1 },
    maxOutputBytes: { type: 'integer', minimum: 1 },
  },
  additionalProperties: false,
};

/** Machine-readable Semantic UI operation definitions (noun.verb contract). */
export const ONTOLOGY_OPERATIONS = Object.freeze([
  Object.freeze({
    operation: 'ontology.build',
    noun: 'ontology',
    verb: 'build',
    readOnly: true,
    idempotent: true,
    summary: 'Build and verify a canonical DAG-CBOR IPLD ontology snapshot (with tag-42 CID links and CARv1 output). Remote JSON-LD @context fetch is disabled.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Logical snapshot identifier.' },
        baseIri: { type: 'string', description: 'Base IRI for fact-to-quad projection.' },
        createdAt: { type: 'string', description: 'Optional ISO-8601 timestamp.' },
        basisCid: BASIS_CID_PROP,
        includeDefaults: { type: 'boolean', description: 'Include default kotoba.ontology (:tender) and connector (:jp.kkj, :jp.geps) registries.' },
        objectTypes: { type: 'array', description: 'Object type definitions.' },
        connectors: { type: 'array', description: 'Registered external-data connector definitions.' },
        facts: { type: 'array', description: 'Normalized facts tagged with connectorId or ontology/source.' },
        quads: { type: 'array', description: 'Explicit RDF quads.' },
        jsonLd: { description: 'JSON-LD object or array; remote @context requires pinnedContexts.' },
        pinnedContexts: { type: 'object', description: 'Explicitly pinned JSON-LD context map { [url]: contextObj }.' },
        joinMappings: { type: 'array', description: 'Declared relational join mappings between object types.' },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      required: ['basisCid', 'schema', 'blockCids', 'stats', 'carBase64'],
      properties: {
        basisCid: BASIS_CID_PROP,
        schema: { type: 'string' },
        blockCids: { type: 'object' },
        stats: { type: 'object' },
        carBase64: { type: 'string' },
      },
    },
  }),
  Object.freeze({
    operation: 'ontology.verify',
    noun: 'ontology',
    verb: 'verify',
    readOnly: true,
    idempotent: true,
    summary: 'Verify a CARv1/CARv2 ontology snapshot: CIDv1 sha2-256 digests, canonical DAG-CBOR, complete closure, and connector provenance.',
    inputSchema: {
      type: 'object',
      properties: {
        carBase64: { type: 'string', description: 'Base64-encoded CARv1/CARv2 ontology snapshot.' },
        basisCid: BASIS_CID_PROP,
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      required: ['verified', 'basisCid', 'schema', 'blockCids', 'stats'],
      properties: {
        verified: { type: 'boolean' },
        basisCid: BASIS_CID_PROP,
        schema: { type: 'string' },
        blockCids: { type: 'object' },
        stats: { type: 'object' },
      },
    },
  }),
  Object.freeze({
    operation: 'ontology.inspect',
    noun: 'ontology',
    verb: 'inspect',
    readOnly: true,
    idempotent: true,
    summary: 'Inspect a verified ontology snapshot: object types, connectors, provenance summary, relational table schemas, join mappings, and CID links.',
    inputSchema: {
      type: 'object',
      properties: {
        basisCid: BASIS_CID_PROP,
        carBase64: { type: 'string', description: 'Optional base64 CAR when evaluating statelessly.' },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      required: ['basisCid', 'schema', 'id', 'blockCids', 'stats', 'objectTypes', 'connectors', 'tables', 'joinMappings'],
      properties: {
        basisCid: BASIS_CID_PROP,
        schema: { type: 'string' },
        id: { type: 'string' },
        blockCids: { type: 'object' },
        stats: { type: 'object' },
        objectTypes: { type: 'array' },
        connectors: { type: 'array' },
        tables: { type: 'array' },
        joinMappings: { type: 'array' },
      },
    },
  }),
  Object.freeze({
    operation: 'ontology.query_sql',
    noun: 'ontology',
    verb: 'query_sql',
    readOnly: true,
    idempotent: true,
    summary: 'Execute a bounded, read-only SQL SELECT query against a pinned ontology basisCid.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        basisCid: BASIS_CID_PROP,
        carBase64: { type: 'string', description: 'Optional base64 CAR when evaluating statelessly.' },
        query: { type: 'string', description: 'Read-only SQL SELECT statement.' },
        jurisdiction: { description: 'Optional jurisdiction visibility filter (string or string[]).' },
        allowedSources: { type: 'array', description: 'Optional allowed connector source IDs.' },
        limits: LIMITS_PROP,
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      required: ['basisCid', 'columns', 'rows', 'rowCount', 'scannedRows', 'readOnly'],
      properties: {
        basisCid: BASIS_CID_PROP,
        columns: { type: 'array' },
        rows: { type: 'array' },
        rowCount: { type: 'integer' },
        scannedRows: { type: 'integer' },
        readOnly: { type: 'boolean' },
      },
    },
  }),
  Object.freeze({
    operation: 'ontology.query_sparql',
    noun: 'ontology',
    verb: 'query_sparql',
    readOnly: true,
    idempotent: true,
    summary: 'Execute a bounded, read-only SPARQL query (or EDN/JSON algebra) against a pinned ontology basisCid.',
    inputSchema: {
      type: 'object',
      properties: {
        basisCid: BASIS_CID_PROP,
        carBase64: { type: 'string', description: 'Optional base64 CAR when evaluating statelessly.' },
        query: { type: 'string', description: 'Read-only SPARQL query string (SELECT/ASK/CONSTRUCT/DESCRIBE).' },
        algebraEdn: { type: 'string', description: 'Optional kotoba.sparql EDN algebra string.' },
        algebra: { type: 'object', description: 'Optional JSON SPARQL algebra object.' },
        jurisdiction: { description: 'Optional jurisdiction visibility filter (string or string[]).' },
        allowedSources: { type: 'array', description: 'Optional allowed connector source IDs.' },
        limits: LIMITS_PROP,
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      required: ['basisCid', 'form', 'algebraEdn', 'readOnly'],
      properties: {
        basisCid: BASIS_CID_PROP,
        form: { type: 'string' },
        variables: { type: 'array' },
        rows: { type: 'array' },
        bindings: { type: 'array' },
        algebra: { type: 'object' },
        algebraEdn: { type: 'string' },
        readOnly: { type: 'boolean' },
      },
    },
  }),
  Object.freeze({
    operation: 'ontology.view',
    noun: 'ontology',
    verb: 'view',
    readOnly: true,
    idempotent: true,
    summary: 'Render a Semantic UI Ontology Viewer representation (structured JSON viewModel, SVG graph, and/or self-contained HTML5 document).',
    inputSchema: {
      type: 'object',
      properties: {
        basisCid: BASIS_CID_PROP,
        carBase64: { type: 'string', description: 'Optional base64 CAR when evaluating statelessly.' },
        format: { type: 'string', enum: ['json', 'svg', 'html', 'all'], description: 'Output representation (default all).' },
        title: { type: 'string', description: 'Optional viewer title.' },
        maxNodes: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum graph nodes rendered in SVG/viewModel (default 48).' },
        apiBase: { type: 'string', description: 'Base URL for interactive viewer operation calls (default /ontology/v1).' },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      required: ['basisCid', 'semanticSchema', 'viewModel'],
      properties: {
        basisCid: BASIS_CID_PROP,
        semanticSchema: { type: 'object' },
        viewModel: { type: 'object' },
        svg: { type: 'string' },
        html: { type: 'string' },
      },
    },
  }),
]);

export function getOntologySchema() {
  return {
    schema: ONTOLOGY_OPERATION_SCHEMA_VERSION,
    snapshotSchema: ONTOLOGY_SNAPSHOT_SCHEMA,
    protocol: 'noun.verb',
    readOnly: true,
    operations: ONTOLOGY_OPERATIONS,
  };
}

export function getOperationSpec(operation) {
  return ONTOLOGY_OPERATIONS.find((op) => op.operation === operation) ?? null;
}

export function inspectOntology(snapshot) {
  const tables = [];
  const seenTables = new Set();
  for (const [, t] of snapshot.tables.entries()) {
    if (seenTables.has(t.name)) continue;
    seenTables.add(t.name);
    const colSet = new Set();
    for (const r of t.rows) for (const k of Object.keys(r)) colSet.add(k);
    tables.push({
      name: t.name,
      rowCount: t.rows.length,
      columns: [...colSet],
    });
  }
  const provenanceSources = {};
  for (const f of snapshot.facts) {
    const src = normalizeKeyword(f['ontology/source']) ?? 'unknown';
    provenanceSources[src] = (provenanceSources[src] ?? 0) + 1;
  }
  return {
    basisCid: snapshot.basisCid,
    schema: snapshot.schema,
    id: snapshot.id,
    baseIri: snapshot.baseIri,
    createdAt: snapshot.createdAt,
    parentBasisCid: snapshot.parentBasisCid,
    blockCids: snapshot.blockCids,
    stats: snapshot.stats,
    provenanceSources,
    objectTypes: snapshot.registry.objectTypes,
    connectors: snapshot.registry.connectors,
    joinMappings: snapshot.joinMappings,
    tables,
  };
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildGraphModel(snapshot, maxNodes = 48) {
  const nodes = [];
  const edges = [];
  const nodeIds = new Set();

  const addNode = (id, label, kind, meta = {}) => {
    if (nodeIds.has(id) || nodes.length >= maxNodes) return;
    nodeIds.add(id);
    nodes.push({ id, label, kind, meta });
  };

  for (const t of snapshot.registry.objectTypes) {
    addNode(`type:${t.id}`, t.id, 'object-type', { name: t.name, attributes: Object.keys(t.attributes) });
  }
  for (const c of snapshot.registry.connectors) {
    addNode(`connector:${c.id}`, c.id, 'connector', { objectType: c.objectType, status: c.status });
    if (nodeIds.has(`type:${c.objectType}`)) {
      edges.push({ from: `connector:${c.id}`, to: `type:${c.objectType}`, label: 'produces', kind: 'provenance' });
    }
  }
  for (const j of snapshot.joinMappings) {
    if (nodeIds.has(`type:${j.leftType}`) && nodeIds.has(`type:${j.rightType}`)) {
      edges.push({
        from: `type:${j.leftType}`,
        to: `type:${j.rightType}`,
        label: `${j.name} (${j.leftKey}=${j.rightKey})`,
        kind: 'join',
      });
    }
  }
  for (const f of snapshot.facts) {
    if (nodes.length >= maxNodes) break;
    const typeId = f['ontology/type'];
    const nid = `fact:${typeId}:${f.id}`;
    addNode(nid, `${typeId}:${f.id}`, 'fact', {
      source: f['ontology/source'],
      status: f.status ?? null,
      jurisdiction: f.jurisdiction ?? null,
    });
    if (nodeIds.has(`type:${typeId}`)) {
      edges.push({ from: nid, to: `type:${typeId}`, label: 'type', kind: 'instance' });
    }
  }

  return {
    nodes,
    edges,
    truncated: snapshot.registry.objectTypes.length + snapshot.registry.connectors.length + snapshot.facts.length > nodes.length,
  };
}

/** Deterministic, XSS-safe SVG graph of types, connectors, joins, and facts. */
export function renderOntologySvg(snapshot, { maxNodes = 48 } = {}) {
  const graph = buildGraphModel(snapshot, maxNodes);
  const cols = { connector: 110, 'object-type': 390, fact: 690 };
  const rowsByKind = { connector: 0, 'object-type': 0, fact: 0 };
  const positions = new Map();

  for (const n of graph.nodes) {
    const row = rowsByKind[n.kind] ?? 0;
    rowsByKind[n.kind] = row + 1;
    positions.set(n.id, { x: cols[n.kind] ?? 390, y: 70 + row * 64 });
  }
  const maxRows = Math.max(1, rowsByKind.connector, rowsByKind['object-type'], rowsByKind.fact);
  const height = Math.max(220, 90 + maxRows * 64);
  const width = 900;

  const fills = {
    connector: { bg: '#e8f4f8', stroke: '#1d6f8a' },
    'object-type': { bg: '#eef7ea', stroke: '#2f6f3e' },
    fact: { bg: '#f7f3e9', stroke: '#8a6220' },
  };

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Ontology Graph for ${escapeXml(snapshot.basisCid)}">`,
    '<defs><marker id="yv-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 1 L 10 5 L 0 9 z" fill="#5c6670"/></marker></defs>',
    `<rect x="0" y="0" width="${width}" height="${height}" fill="#fafbfc" rx="8"/>`,
    '<text x="40" y="30" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12" fill="#475569">Connectors</text>',
    '<text x="320" y="30" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12" fill="#475569">Object Types</text>',
    '<text x="620" y="30" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12" fill="#475569">Facts (Provenance-Tagged)</text>',
  ];

  for (const e of graph.edges) {
    const a = positions.get(e.from);
    const b = positions.get(e.to);
    if (!a || !b) continue;
    const x1 = a.x + (a.x < b.x ? 90 : a.x > b.x ? -90 : 0);
    const y1 = a.y;
    const x2 = b.x + (a.x < b.x ? -90 : a.x > b.x ? 90 : 0);
    const y2 = b.y;
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2 - 6;
    const stroke = e.kind === 'join' ? '#2563eb' : '#64748b';
    const dash = e.kind === 'join' ? ' stroke-dasharray="5,3"' : '';
    parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="1.5"${dash} marker-end="url(#yv-arrow)"/>`);
    parts.push(`<text x="${mx}" y="${my}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="10" fill="#475569">${escapeXml(e.label)}</text>`);
  }

  for (const n of graph.nodes) {
    const p = positions.get(n.id);
    const st = fills[n.kind] ?? { bg: '#ffffff', stroke: '#334155' };
    const text = n.label.length > 24 ? `${n.label.slice(0, 21)}...` : n.label;
    parts.push(`<g data-node-id="${escapeXml(n.id)}" data-node-kind="${escapeXml(n.kind)}">`);
    parts.push(`<rect x="${p.x - 90}" y="${p.y - 20}" width="180" height="40" rx="6" fill="${st.bg}" stroke="${st.stroke}" stroke-width="1.5"/>`);
    parts.push(`<text x="${p.x}" y="${p.y + 4}" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12" fill="#0f172a">${escapeXml(text)}</text>`);
    parts.push('</g>');
  }

  parts.push('</svg>');
  return parts.join('\n');
}

/** Render a self-contained Semantic HTML5 Ontology Viewer (zero external assets). */
export function renderOntologyHtml(snapshot, { title, maxNodes = 48, apiBase = '/ontology/v1' } = {}) {
  const inspection = inspectOntology(snapshot);
  const svg = renderOntologySvg(snapshot, { maxNodes });
  const schema = getOntologySchema();
  const safeTitle = title ?? `Yataverse Ontology Viewer — ${snapshot.id}`;

  const defaultSqlTable = snapshot.registry.objectTypes[0]?.id ?? 'ontology_facts';
  const defaultSql = `SELECT * FROM ${defaultSqlTable} LIMIT 25`;
  const defaultSparql = 'SELECT ?s ?p ?o WHERE { ?s ?p ?o . } LIMIT 25';

  // Escape </script> inside inline JSON script safely
  const safeJsonScript = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c');

  const typeRows = inspection.objectTypes.map((t) =>
    `<tr><td><code>${escapeXml(t.id)}</code></td><td>${escapeXml(t.name)}</td><td><code>${escapeXml(Object.keys(t.attributes).join(', '))}</code></td></tr>`
  ).join('\n');

  const connectorRows = inspection.connectors.map((c) =>
    `<tr><td><code>${escapeXml(c.id)}</code></td><td>${escapeXml(c.name)}</td><td><code>${escapeXml(c.objectType)}</code></td><td>${escapeXml(c.status)}</td></tr>`
  ).join('\n');

  const tableRows = inspection.tables.map((t) =>
    `<tr><td><code>${escapeXml(t.name)}</code></td><td>${t.rowCount}</td><td><code>${escapeXml(t.columns.join(', '))}</code></td></tr>`
  ).join('\n');

  const opRows = schema.operations.map((op) =>
    `<tr><td><code>${escapeXml(op.operation)}</code></td><td>${escapeXml(op.noun)}</td><td>${escapeXml(op.verb)}</td><td>${op.readOnly ? 'read-only' : 'write'}</td><td>${escapeXml(op.summary)}</td></tr>`
  ).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeXml(safeTitle)}</title>
  <style>
    :root { --yv-bg: #f8fafc; --yv-surface: #ffffff; --yv-border: #cbd5e1; --yv-ink: #0f172a; --yv-muted: #475569; --yv-accent: #1d4ed8; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: var(--yv-bg); color: var(--yv-ink); line-height: 1.5; }
    header, main { max-width: 1120px; margin: 0 auto; padding: 1rem 1.25rem; }
    header { border-bottom: 1px solid var(--yv-border); background: var(--yv-surface); }
    h1 { margin: 0 0 0.25rem 0; font-size: 1.4rem; }
    h2 { margin: 1.5rem 0 0.5rem 0; font-size: 1.1rem; }
    .yv-meta { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85rem; color: var(--yv-muted); word-break: break-all; }
    .yv-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 0.75rem; margin: 1rem 0; }
    .yv-card { background: var(--yv-surface); border: 1px solid var(--yv-border); border-radius: 8px; padding: 0.75rem 1rem; }
    .yv-card strong { display: block; font-size: 1.35rem; }
    section { background: var(--yv-surface); border: 1px solid var(--yv-border); border-radius: 8px; padding: 1rem; margin: 1rem 0; }
    table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    th, td { text-align: left; padding: 0.45rem 0.6rem; border-bottom: 1px solid var(--yv-border); vertical-align: top; }
    th { background: #f1f5f9; }
    textarea { width: 100%; min-height: 5.5rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9rem; padding: 0.5rem; border: 1px solid var(--yv-border); border-radius: 6px; }
    button { margin-top: 0.5rem; padding: 0.45rem 0.9rem; border: 1px solid var(--yv-accent); background: var(--yv-accent); color: #ffffff; border-radius: 6px; cursor: pointer; font-weight: 600; }
    pre { background: #0f172a; color: #e2e8f0; padding: 0.75rem; border-radius: 6px; overflow: auto; font-size: 0.82rem; max-height: 320px; }
    .yv-graph { overflow-x: auto; }
    nav { display: flex; gap: 1rem; flex-wrap: wrap; margin-top: 0.5rem; font-size: 0.9rem; }
    nav a { color: var(--yv-accent); text-decoration: none; }
  </style>
</head>
<body data-basis-cid="${escapeXml(snapshot.basisCid)}" data-schema="${escapeXml(snapshot.schema)}">
  <header>
    <h1>${escapeXml(safeTitle)}</h1>
    <div class="yv-meta">basisCid: <code>${escapeXml(snapshot.basisCid)}</code> · schema: <code>${escapeXml(snapshot.schema)}</code> · read-only</div>
    <nav aria-label="Viewer sections">
      <a href="#graph">Graph</a>
      <a href="#sql">SQL Query</a>
      <a href="#sparql">SPARQL Query</a>
      <a href="#registry">Registry &amp; Tables</a>
      <a href="#operations">Semantic Operations</a>
    </nav>
  </header>
  <main>
    <div class="yv-grid" aria-label="Snapshot summary">
      <article class="yv-card"><span>Object Types</span><strong>${inspection.stats.objectTypes}</strong></article>
      <article class="yv-card"><span>Connectors</span><strong>${inspection.stats.connectors}</strong></article>
      <article class="yv-card"><span>Facts</span><strong>${inspection.stats.facts}</strong></article>
      <article class="yv-card"><span>RDF Quads</span><strong>${inspection.stats.quads}</strong></article>
      <article class="yv-card"><span>Join Mappings</span><strong>${inspection.stats.joins}</strong></article>
    </div>

    <section id="graph" aria-labelledby="graph-heading" data-operation="ontology.view">
      <h2 id="graph-heading">Ontology Graph</h2>
      <div class="yv-graph">${svg}</div>
    </section>

    <section id="sql" aria-labelledby="sql-heading">
      <h2 id="sql-heading">SQL Query (Read-Only, Basis-Pinned)</h2>
      <form data-operation="ontology.query_sql" id="yv-sql-form">
        <label for="yv-sql-input">SQL SELECT</label>
        <textarea id="yv-sql-input" name="query">${escapeXml(defaultSql)}</textarea>
        <button type="submit">Run ontology.query_sql</button>
      </form>
      <pre id="yv-sql-out" aria-live="polite">Submit a SQL SELECT query against ${escapeXml(snapshot.basisCid)}.</pre>
    </section>

    <section id="sparql" aria-labelledby="sparql-heading">
      <h2 id="sparql-heading">SPARQL Query (Read-Only, Basis-Pinned)</h2>
      <form data-operation="ontology.query_sparql" id="yv-sparql-form">
        <label for="yv-sparql-input">SPARQL</label>
        <textarea id="yv-sparql-input" name="query">${escapeXml(defaultSparql)}</textarea>
        <button type="submit">Run ontology.query_sparql</button>
      </form>
      <pre id="yv-sparql-out" aria-live="polite">Submit a SPARQL query against ${escapeXml(snapshot.basisCid)}.</pre>
    </section>

    <section id="registry" aria-labelledby="registry-heading" data-operation="ontology.inspect">
      <h2 id="registry-heading">Vocabulary Registry &amp; Relational Tables</h2>
      <h3>Object Types</h3>
      <table><thead><tr><th>ID</th><th>Name</th><th>Required Attributes</th></tr></thead><tbody>${typeRows}</tbody></table>
      <h3>Registered Connectors</h3>
      <table><thead><tr><th>ID</th><th>Name</th><th>Object Type</th><th>Status</th></tr></thead><tbody>${connectorRows}</tbody></table>
      <h3>Projected Tables</h3>
      <table><thead><tr><th>Table</th><th>Rows</th><th>Columns</th></tr></thead><tbody>${tableRows}</tbody></table>
    </section>

    <section id="operations" aria-labelledby="ops-heading">
      <h2 id="ops-heading">Semantic UI Operations (noun.verb Contract)</h2>
      <table><thead><tr><th>Operation</th><th>Noun</th><th>Verb</th><th>Mode</th><th>Summary</th></tr></thead><tbody>${opRows}</tbody></table>
    </section>
  </main>

  <script type="application/json" id="yataverse-semantic-schema">${safeJsonScript({ basisCid: snapshot.basisCid, apiBase, schema, inspection })}</script>
  <script>
    (function () {
      var meta = JSON.parse(document.getElementById('yataverse-semantic-schema').textContent);
      function bindForm(formId, inputId, outId, op) {
        var form = document.getElementById(formId);
        var input = document.getElementById(inputId);
        var out = document.getElementById(outId);
        if (!form) return;
        form.addEventListener('submit', async function (ev) {
          ev.preventDefault();
          out.textContent = 'Running ' + op + '...';
          try {
            var res = await fetch(meta.apiBase + '/ops/' + encodeURIComponent(op), {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ basisCid: meta.basisCid, query: input.value }),
            });
            var data = await res.json();
            out.textContent = JSON.stringify(data, null, 2);
          } catch (err) {
            out.textContent = 'Error: ' + String(err);
          }
        });
      }
      bindForm('yv-sql-form', 'yv-sql-input', 'yv-sql-out', 'ontology.query_sql');
      bindForm('yv-sparql-form', 'yv-sparql-input', 'yv-sparql-out', 'ontology.query_sparql');
    })();
  </script>
</body>
</html>`;
}

/** Build the complete Ontology Viewer payload (viewModel, optional SVG, optional HTML). */
export function renderOntologyViewer(snapshot, { format = 'all', title, maxNodes = 48, apiBase = '/ontology/v1' } = {}) {
  if (!['json', 'svg', 'html', 'all'].includes(format)) {
    throw new OntologyError('invalid-view-format', `expected json|svg|html|all, got ${format}`);
  }
  const inspection = inspectOntology(snapshot);
  const graph = buildGraphModel(snapshot, maxNodes);
  const semanticSchema = getOntologySchema();
  const viewModel = {
    basisCid: snapshot.basisCid,
    schema: snapshot.schema,
    id: snapshot.id,
    stats: snapshot.stats,
    inspection,
    graph,
    operations: semanticSchema.operations.map((o) => ({
      operation: o.operation,
      noun: o.noun,
      verb: o.verb,
      readOnly: o.readOnly,
    })),
  };
  const out = { basisCid: snapshot.basisCid, semanticSchema, viewModel };
  if (format === 'svg' || format === 'all') out.svg = renderOntologySvg(snapshot, { maxNodes });
  if (format === 'html' || format === 'all') out.html = renderOntologyHtml(snapshot, { title, maxNodes, apiBase });
  return out;
}

/**
 * Unified Semantic UI noun.verb operation dispatcher.
 * `context` may supply an already-verified `snapshot`, or an async `loadSnapshot(basisCid)` loader.
 */
export async function invokeOntologyOperation(operation, input = {}, context = {}) {
  if (typeof operation !== 'string' || !NOUN_VERB_PATTERN.test(operation)) {
    throw new OntologyError('invalid-operation-name', String(operation));
  }
  const spec = getOperationSpec(operation);
  if (!spec) throw new OntologyError('unknown-operation', operation);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new OntologyError('invalid-operation-input', 'input must be an object');
  }
  // Reject unknown fields per inputSchema.additionalProperties === false
  const allowedKeys = new Set(Object.keys(spec.inputSchema.properties ?? {}));
  for (const k of Object.keys(input)) {
    if (!allowedKeys.has(k)) throw new OntologyError('unknown-input-field', `${operation}.${k}`);
  }
  for (const req of spec.inputSchema.required ?? []) {
    if (input[req] === undefined || input[req] === null) {
      throw new OntologyError('missing-required-field', `${operation}.${req}`);
    }
  }

  if (operation === 'ontology.build') {
    const snap = buildOntologySnapshot(input, { limits: context.limits });
    return {
      ok: true,
      operation,
      schemaVersion: ONTOLOGY_OPERATION_SCHEMA_VERSION,
      basisCid: snap.basisCid,
      result: {
        basisCid: snap.basisCid,
        schema: snap.schema,
        id: snap.id,
        blockCids: snap.blockCids,
        stats: snap.stats,
        carBase64: Buffer.from(snap.carBytes).toString('base64'),
      },
    };
  }

  // Resolve verified snapshot from carBase64, context.snapshot, or context.loadSnapshot(basisCid)
  let snapshot = null;
  if (typeof input.carBase64 === 'string') {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.carBase64)) {
      throw new OntologyError('invalid-car-base64', 'malformed base64');
    }
    const carBytes = Buffer.from(input.carBase64, 'base64');
    snapshot = verifyOntologySnapshot(carBytes, { expectedBasisCid: input.basisCid ?? null, limits: context.limits });
  } else if (context.snapshot) {
    snapshot = context.snapshot;
    if (input.basisCid && snapshot.basisCid !== input.basisCid) {
      throw new OntologyError('basis-cid-mismatch', `expected ${input.basisCid}, got ${snapshot.basisCid}`);
    }
  } else if (input.basisCid && typeof context.loadSnapshot === 'function') {
    snapshot = await context.loadSnapshot(input.basisCid);
  } else {
    throw new OntologyError('missing-snapshot', 'provide carBase64, context.snapshot, or basisCid with a loader');
  }

  let result;
  if (operation === 'ontology.verify') {
    result = {
      verified: true,
      basisCid: snapshot.basisCid,
      schema: snapshot.schema,
      id: snapshot.id,
      blockCids: snapshot.blockCids,
      stats: snapshot.stats,
    };
  } else if (operation === 'ontology.inspect') {
    result = inspectOntology(snapshot);
  } else if (operation === 'ontology.query_sql') {
    result = executeSql(snapshot, input.query, {
      basisCid: input.basisCid ?? snapshot.basisCid,
      jurisdiction: input.jurisdiction,
      allowedSources: input.allowedSources,
      visible: context.visible,
      limits: { ...context.sqlLimits, ...input.limits },
    });
  } else if (operation === 'ontology.query_sparql') {
    const hasQuery = typeof input.query === 'string';
    const hasEdn = typeof input.algebraEdn === 'string';
    const hasAlg = input.algebra && typeof input.algebra === 'object';
    if ((hasQuery ? 1 : 0) + (hasEdn ? 1 : 0) + (hasAlg ? 1 : 0) !== 1) {
      throw new OntologyError('invalid-sparql-arguments', 'provide exactly one of query, algebraEdn, or algebra');
    }
    const q = hasQuery ? input.query : (hasEdn ? { edn: input.algebraEdn } : input.algebra);
    result = executeSparql(snapshot, q, {
      basisCid: input.basisCid ?? snapshot.basisCid,
      jurisdiction: input.jurisdiction,
      allowedSources: input.allowedSources,
      visible: context.visible,
      limits: { ...context.sparqlLimits, ...input.limits },
    });
  } else if (operation === 'ontology.view') {
    result = renderOntologyViewer(snapshot, {
      format: input.format ?? 'all',
      title: input.title,
      maxNodes: input.maxNodes ?? 48,
      apiBase: input.apiBase ?? '/ontology/v1',
    });
  }

  return {
    ok: true,
    operation,
    schemaVersion: ONTOLOGY_OPERATION_SCHEMA_VERSION,
    basisCid: snapshot.basisCid,
    result,
  };
}
