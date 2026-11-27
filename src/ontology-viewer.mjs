// Semantic UI / noun.verb operation contract and read-only Ontology Viewer dispatcher.
//
// Design constraints:
// - Strictly Semantic UI / noun.verb operations with machine-readable input/output schemas:
//   ontology.graph, ontology.inspect, ontology.query_sql, ontology.query_sparql,
//   ontology.view, ontology.build, ontology.verify.
// - Visualization rendering delegated to reusable zero-dependency src/ontology-viz.mjs.
// - Read-only, basisCid-pinned, bounded, XSS-safe.

import {
  ONTOLOGY_SNAPSHOT_SCHEMA,
  OntologyError,
  buildOntologySnapshot,
  verifyOntologySnapshot,
  normalizeKeyword,
} from './ontology.mjs';
import { executeSql } from './ontology-sql.mjs';
import { executeSparql } from './ontology-sparql.mjs';
import {
  ONTOLOGY_GRAPH_SCHEMA,
  buildOntologyGraph,
  encodeOntologyGraphDagCbor,
  renderOntologySvg,
  renderOntologyHtml,
  renderYataverseHomeHtml,
  createDefaultOntologySnapshot,
} from './ontology-viz.mjs';

export {
  ONTOLOGY_GRAPH_SCHEMA,
  buildOntologyGraph,
  encodeOntologyGraphDagCbor,
  renderOntologySvg,
  renderOntologyHtml,
  renderYataverseHomeHtml,
  createDefaultOntologySnapshot,
};

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
    operation: 'ontology.graph',
    noun: 'ontology',
    verb: 'graph',
    readOnly: true,
    idempotent: true,
    summary: 'Project a verified ontology snapshot into a canonical layered graph model (nodes, edges, layers, joins, coverage) with its canonical DAG-CBOR CID.',
    inputSchema: {
      type: 'object',
      properties: {
        basisCid: BASIS_CID_PROP,
        carBase64: { type: 'string', description: 'Optional base64 CAR when evaluating statelessly.' },
        maxNodes: { type: 'integer', minimum: 1, maximum: 500, description: 'Maximum graph nodes returned (default 64).' },
        includeRdfSubjects: { type: 'boolean', description: 'Include standalone RDF subjects outside fact projections.' },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      required: ['schema', 'basisCid', 'graphCid', 'layers', 'nodes', 'edges', 'joins', 'coverage'],
      properties: {
        schema: { type: 'string' },
        basisCid: BASIS_CID_PROP,
        graphCid: { type: 'string' },
        layers: { type: 'array' },
        nodes: { type: 'array' },
        edges: { type: 'array' },
        joins: { type: 'array' },
        coverage: { type: 'object' },
      },
    },
  }),
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
    summary: 'Render a Semantic UI Ontology Viewer representation (structured JSON viewModel, SVG graph, and/or interactive HTML5 document).',
    inputSchema: {
      type: 'object',
      properties: {
        basisCid: BASIS_CID_PROP,
        carBase64: { type: 'string', description: 'Optional base64 CAR when evaluating statelessly.' },
        format: { type: 'string', enum: ['json', 'svg', 'html', 'all'], description: 'Output representation (default all).' },
        title: { type: 'string', description: 'Optional viewer title.' },
        maxNodes: { type: 'integer', minimum: 1, maximum: 500, description: 'Maximum graph nodes rendered in SVG/viewModel (default 64).' },
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
    graphSchema: ONTOLOGY_GRAPH_SCHEMA,
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

/** Build the complete Ontology Viewer payload (viewModel, optional SVG, optional HTML). */
export function renderOntologyViewer(snapshot, {
  format = 'all',
  title,
  maxNodes = 64,
  apiBase = '/ontology/v1',
  sqlEndpoint = '/ontology/sql',
  sparqlEndpoint = '/ontology/sparql',
  viewerPath = '/ontology/viewer',
  graphEndpoint = '/ontology/graph',
  isSeededDefault = false,
} = {}) {
  if (!['json', 'svg', 'html', 'all'].includes(format)) {
    throw new OntologyError('invalid-view-format', `expected json|svg|html|all, got ${format}`);
  }
  const inspection = inspectOntology(snapshot);
  const graph = buildOntologyGraph(snapshot, { maxNodes });
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
  if (format === 'svg' || format === 'all') out.svg = renderOntologySvg(graph, { maxNodes });
  if (format === 'html' || format === 'all') {
    out.html = renderOntologyHtml(snapshot, {
      title,
      maxNodes,
      apiBase,
      sqlEndpoint,
      sparqlEndpoint,
      viewerPath,
      graphEndpoint,
      schema: semanticSchema,
      inspection,
      isSeededDefault,
    });
  }
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
  if (operation === 'ontology.graph') {
    const graph = buildOntologyGraph(snapshot, {
      maxNodes: input.maxNodes ?? 64,
      includeRdfSubjects: Boolean(input.includeRdfSubjects),
    });
    const { cid: graphCid } = encodeOntologyGraphDagCbor(graph);
    result = { ...graph, graphCid };
  } else if (operation === 'ontology.verify') {
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
      maxNodes: input.maxNodes ?? 64,
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
