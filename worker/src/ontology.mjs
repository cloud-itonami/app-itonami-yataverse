// Worker HTTP surface for bounded, read-only, basis-pinned Ontology visualization,
// canonical graph export, and SQL/SPARQL querying on https://yataverse.com/.
//
// Top-level visualization routes:
//   GET  /                               -> Yataverse landing + immediate Ontology Viewer entry
//                                           (with ?cid=<bafy...>, loads & renders that verified snapshot)
//   GET  /ontology, GET /ontology/viewer -> Interactive Ontology Viewer HTML (?cid=<bafy...>&format=html|svg|json)
//   GET  /ontology/graph                 -> Canonical graph model (?cid=<bafy...>&format=json|dag-cbor)
//   POST /ontology/sql                   -> Read-only SQL SELECT against pinned CID or seeded snapshot
//   POST /ontology/sparql                -> Read-only SPARQL / EDN algebra against pinned CID or seeded snapshot
//
// Versioned Semantic UI operation routes (/ontology/v1/):
//   GET  /ontology/v1/schema             -> Semantic UI noun.verb operation catalog & schemas
//   GET  /ontology/v1/inspect/<cid>      -> ontology.inspect for a verified DAG-CBOR snapshot CID
//   GET  /ontology/v1/view/<cid>         -> Semantic UI HTML/SVG/JSON viewer (?format=html|svg|json)
//   POST /ontology/v1/ops/<operation>    -> invoke noun.verb operation (read-only)
//
// Reads blocks strictly through the Worker's existing readPublicBlock + collectDag pipeline
// (so READ_DENY_CIDS 451 and SHA2-256 CID verification are always enforced). Never writes to B2.

import { parseCid, CODEC_DAG_CBOR, SHA2_256 } from '../../src/cid.mjs';
import { collectDag, DagError } from '../../src/dag.mjs';
import { verifyOntologySnapshot, OntologyError } from '../../src/ontology.mjs';
import { SqlError } from '../../src/ontology-sql.mjs';
import { SparqlError } from '../../src/ontology-sparql.mjs';
import {
  getOntologySchema,
  getOperationSpec,
  invokeOntologyOperation,
  renderOntologyViewer,
  buildOntologyGraph,
  encodeOntologyGraphDagCbor,
  renderYataverseHomeHtml,
  createDefaultOntologySnapshot,
} from '../../src/ontology-viewer.mjs';

export const ONTOLOGY_PREFIX = '/ontology/v1/';
const MAX_OP_BODY_BYTES = 2 * 1024 * 1024;
const DAG_CBOR_CT = 'application/vnd.ipld.dag-cbor';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
};

const HTML_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:;";

const jsonRes = (status, body, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });

const failRes = (status, error, detail, extra = {}) =>
  jsonRes(status, { ok: false, error, ...(detail ? { detail } : {}) }, extra);

class LoaderHttpError extends Error {
  constructor(status, code, headers = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export function isOntologyRoute(pathname) {
  return pathname === '/'
    || pathname === '/ontology'
    || pathname === '/ontology/'
    || pathname === '/ontology/viewer'
    || pathname === '/ontology/graph'
    || pathname === '/ontology/sql'
    || pathname === '/ontology/sparql'
    || pathname.startsWith(ONTOLOGY_PREFIX);
}

async function loadSnapshotFromStore(cid, { readPublicBlock, hasStore, carLimits, denyHeaders }) {
  const parsed = parseCid(cid);
  if (!parsed || parsed.version !== 1 || parsed.codec !== CODEC_DAG_CBOR || parsed.hashCode !== SHA2_256) {
    throw new LoaderHttpError(400, 'invalid-basis-cid');
  }
  if (!hasStore) throw new LoaderHttpError(503, 'store-not-configured');
  let blocks;
  try {
    blocks = await collectDag(cid, 'all', async (c) => {
      const r = await readPublicBlock(c);
      if (r.denied) throw new LoaderHttpError(r.error[0], r.error[1], denyHeaders);
      if (r.error) throw new LoaderHttpError(r.error[0], r.error[1]);
      return r.absent ? null : r.bytes;
    }, carLimits);
  } catch (e) {
    if (e instanceof LoaderHttpError) throw e;
    if (e instanceof DagError) {
      if (e.code === 'root-not-found') throw new LoaderHttpError(404, 'ontology-snapshot-not-found');
      if (e.code === 'closure-incomplete') throw new LoaderHttpError(502, `closure-incomplete:${e.message}`);
      throw new LoaderHttpError(422, e.code);
    }
    throw e;
  }
  const map = new Map(blocks.map((b) => [b.cid, b.bytes]));
  return verifyOntologySnapshot(map, { rootCid: cid, expectedBasisCid: cid });
}

/** Resolve either a stored CID snapshot (when cid is provided) or the seeded default snapshot. */
async function resolveSnapshotByQuery(cidParam, storeCtx) {
  if (!cidParam) {
    return { snapshot: createDefaultOntologySnapshot(), isSeededDefault: true };
  }
  const seeded = createDefaultOntologySnapshot();
  if (cidParam === seeded.basisCid && !storeCtx.hasStore) {
    return { snapshot: seeded, isSeededDefault: true };
  }
  const snapshot = await loadSnapshotFromStore(cidParam, storeCtx);
  return { snapshot, isSeededDefault: false };
}

function errorToResponse(e) {
  if (e instanceof LoaderHttpError) return failRes(e.status, e.code, null, e.headers);
  if (e instanceof OntologyError || e instanceof SqlError || e instanceof SparqlError) {
    const status = (e.code === 'unknown-operation') ? 404
      : (e.code === 'scan-limit-exceeded' || e.code === 'result-limit-exceeded' || e.code === 'solution-limit-exceeded' || e.code === 'output-size-exceeded' || e.code === 'limit-exceeded') ? 422
      : 400;
    return failRes(status, e.code, e.detail);
  }
  throw e;
}

function viewerResponse(rendered, format, snapshot, head, immutable) {
  const cacheControl = immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=300';
  if (format === 'html') {
    return new Response(head ? null : rendered.html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'x-content-type-options': 'nosniff',
        'content-security-policy': HTML_CSP,
        'cache-control': cacheControl,
        etag: `"${snapshot.basisCid}.html"`,
      },
    });
  }
  if (format === 'svg') {
    return new Response(head ? null : rendered.svg, {
      status: 200,
      headers: {
        'content-type': 'image/svg+xml; charset=utf-8',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none';",
        'cache-control': cacheControl,
        etag: `"${snapshot.basisCid}.svg"`,
      },
    });
  }
  return new Response(head ? null : JSON.stringify(rendered), {
    status: 200,
    headers: { ...JSON_HEADERS, 'cache-control': cacheControl, etag: `"${snapshot.basisCid}.json"` },
  });
}

async function handleDirectQuery(request, operation, storeCtx) {
  if (request.method !== 'POST') {
    return failRes(405, 'method-not-allowed', null, { allow: 'POST' });
  }
  const raw = await storeCtx.readCapped(request, MAX_OP_BODY_BYTES);
  if (!raw) return failRes(413, 'body-too-large');
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return failRes(400, 'body-not-json'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return failRes(400, 'invalid-operation-input', 'body must be a JSON object');
  }
  const opInput = { ...body };
  const requestedCid = opInput.cid ?? opInput.basisCid ?? null;
  delete opInput.cid;
  if (requestedCid && !opInput.basisCid) opInput.basisCid = requestedCid;

  try {
    const seeded = createDefaultOntologySnapshot();
    const useSeeded = !opInput.carBase64 && (!requestedCid || requestedCid === seeded.basisCid);
    const context = useSeeded
      ? { snapshot: seeded }
      : { loadSnapshot: (cid) => loadSnapshotFromStore(cid, storeCtx) };
    const res = await invokeOntologyOperation(operation, opInput, context);
    return jsonRes(200, res);
  } catch (e) {
    return errorToResponse(e);
  }
}

export async function handleOntology(request, url, storeCtx) {
  const pathname = url.pathname;
  const head = request.method === 'HEAD';

  // 1. GET / -> Yataverse landing + immediate Ontology Viewer entry (or ?cid=<bafy...> viewer)
  if (pathname === '/') {
    if (request.method !== 'GET' && !head) {
      return failRes(405, 'method-not-allowed', null, { allow: 'GET, HEAD' });
    }
    const cidParam = url.searchParams.get('cid');
    if (cidParam) {
      const format = url.searchParams.get('format')
        ?? ((request.headers.get('accept') ?? '').includes('application/json') ? 'json' : 'html');
      if (!['html', 'svg', 'json'].includes(format)) {
        return failRes(400, 'invalid-view-format', 'expected html, svg, or json');
      }
      try {
        const snapshot = await loadSnapshotFromStore(cidParam, storeCtx);
        const rendered = renderOntologyViewer(snapshot, { format, apiBase: '/ontology/v1' });
        return viewerResponse(rendered, format, snapshot, head, true);
      } catch (e) { return errorToResponse(e); }
    }
    const seeded = createDefaultOntologySnapshot();
    const schema = getOntologySchema();
    const accept = (request.headers.get('accept') ?? '').toLowerCase();
    if (url.searchParams.get('format') === 'json' || (accept.includes('application/json') && !accept.includes('text/html'))) {
      const payload = JSON.stringify({
        ok: true,
        service: 'yataverse-bytes',
        defaultBasisCid: seeded.basisCid,
        routes: {
          viewer: '/ontology/viewer',
          graph: '/ontology/graph',
          sql: '/ontology/sql',
          sparql: '/ontology/sparql',
          schema: '/ontology/v1/schema',
          health: '/health',
        },
        schema,
      });
      return new Response(head ? null : payload, {
        status: 200,
        headers: { ...JSON_HEADERS, 'cache-control': 'public, max-age=300' },
      });
    }
    const html = renderYataverseHomeHtml(seeded, { schema });
    return new Response(head ? null : html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'x-content-type-options': 'nosniff',
        'content-security-policy': HTML_CSP,
        'cache-control': 'public, max-age=300',
      },
    });
  }

  // 2. GET /ontology | /ontology/ | /ontology/viewer -> interactive Ontology Viewer HTML/SVG/JSON
  if (pathname === '/ontology' || pathname === '/ontology/' || pathname === '/ontology/viewer') {
    if (request.method !== 'GET' && !head) {
      return failRes(405, 'method-not-allowed', null, { allow: 'GET, HEAD' });
    }
    const cidParam = url.searchParams.get('cid');
    const format = url.searchParams.get('format')
      ?? ((request.headers.get('accept') ?? '').includes('application/json') ? 'json' : 'html');
    if (!['html', 'svg', 'json'].includes(format)) {
      return failRes(400, 'invalid-view-format', 'expected html, svg, or json');
    }
    try {
      const { snapshot, isSeededDefault } = await resolveSnapshotByQuery(cidParam, storeCtx);
      const rendered = renderOntologyViewer(snapshot, { format, apiBase: '/ontology/v1', isSeededDefault });
      return viewerResponse(rendered, format, snapshot, head, !isSeededDefault);
    } catch (e) { return errorToResponse(e); }
  }

  // 3. GET /ontology/graph -> canonical layered graph (JSON or DAG-CBOR)
  if (pathname === '/ontology/graph') {
    if (request.method !== 'GET' && !head) {
      return failRes(405, 'method-not-allowed', null, { allow: 'GET, HEAD' });
    }
    const cidParam = url.searchParams.get('cid');
    const accept = (request.headers.get('accept') ?? '').toLowerCase();
    const format = url.searchParams.get('format') ?? (accept.includes(DAG_CBOR_CT) ? 'dag-cbor' : 'json');
    if (format !== 'json' && format !== 'dag-cbor') {
      return failRes(400, 'invalid-graph-format', 'expected json or dag-cbor');
    }
    const maxNodesRaw = url.searchParams.get('maxNodes');
    const maxNodes = maxNodesRaw ? Number(maxNodesRaw) : 64;
    if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 500) {
      return failRes(400, 'invalid-max-nodes', 'maxNodes must be an integer between 1 and 500');
    }
    try {
      const { snapshot, isSeededDefault } = await resolveSnapshotByQuery(cidParam, storeCtx);
      const graph = buildOntologyGraph(snapshot, {
        maxNodes,
        includeRdfSubjects: url.searchParams.get('includeRdfSubjects') === 'true',
      });
      const { cid: graphCid, bytes: cborBytes } = encodeOntologyGraphDagCbor(graph);
      const cacheControl = isSeededDefault ? 'public, max-age=300' : 'public, max-age=31536000, immutable';
      if (format === 'dag-cbor') {
        return new Response(head ? null : cborBytes, {
          status: 200,
          headers: {
            'content-type': DAG_CBOR_CT,
            'content-length': String(cborBytes.length),
            'x-content-type-options': 'nosniff',
            'cache-control': cacheControl,
            etag: `"${graphCid}"`,
            'yataverse-graph-cid': graphCid,
          },
        });
      }
      const payload = JSON.stringify({
        ok: true,
        operation: 'ontology.graph',
        basisCid: snapshot.basisCid,
        graphCid,
        result: { ...graph, graphCid },
      });
      return new Response(head ? null : payload, {
        status: 200,
        headers: {
          ...JSON_HEADERS,
          'cache-control': cacheControl,
          etag: `"${graphCid}"`,
          'yataverse-graph-cid': graphCid,
        },
      });
    } catch (e) { return errorToResponse(e); }
  }

  // 4. POST /ontology/sql & POST /ontology/sparql
  if (pathname === '/ontology/sql') {
    return handleDirectQuery(request, 'ontology.query_sql', storeCtx);
  }
  if (pathname === '/ontology/sparql') {
    return handleDirectQuery(request, 'ontology.query_sparql', storeCtx);
  }

  // 5. Versioned /ontology/v1/* Semantic UI operation routes
  if (!pathname.startsWith(ONTOLOGY_PREFIX)) return failRes(404, 'not-found');
  const path = pathname.slice(ONTOLOGY_PREFIX.length);

  if (path === 'schema') {
    if (request.method !== 'GET' && !head) {
      return failRes(405, 'method-not-allowed', null, { allow: 'GET, HEAD' });
    }
    const body = JSON.stringify(getOntologySchema());
    return new Response(head ? null : body, {
      status: 200,
      headers: { ...JSON_HEADERS, 'cache-control': 'public, max-age=300' },
    });
  }

  const inspectMatch = /^inspect\/([A-Za-z0-9]+)$/.exec(path);
  if (inspectMatch) {
    if (request.method !== 'GET' && !head) {
      return failRes(405, 'method-not-allowed', null, { allow: 'GET, HEAD' });
    }
    try {
      const snapshot = await loadSnapshotFromStore(inspectMatch[1], storeCtx);
      const res = await invokeOntologyOperation('ontology.inspect', { basisCid: snapshot.basisCid }, { snapshot });
      const body = JSON.stringify(res);
      return new Response(head ? null : body, {
        status: 200,
        headers: { ...JSON_HEADERS, 'cache-control': 'public, max-age=31536000, immutable', etag: `"${snapshot.basisCid}"` },
      });
    } catch (e) { return errorToResponse(e); }
  }

  const viewMatch = /^view\/([A-Za-z0-9]+)$/.exec(path);
  if (viewMatch) {
    if (request.method !== 'GET' && !head) {
      return failRes(405, 'method-not-allowed', null, { allow: 'GET, HEAD' });
    }
    const format = url.searchParams.get('format')
      ?? ((request.headers.get('accept') ?? '').includes('application/json') ? 'json' : 'html');
    if (!['html', 'svg', 'json'].includes(format)) {
      return failRes(400, 'invalid-view-format', 'expected html, svg, or json');
    }
    try {
      const snapshot = await loadSnapshotFromStore(viewMatch[1], storeCtx);
      const rendered = renderOntologyViewer(snapshot, { format, apiBase: '/ontology/v1' });
      return viewerResponse(rendered, format, snapshot, head, true);
    } catch (e) { return errorToResponse(e); }
  }

  const opMatch = /^ops\/([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)$/.exec(path);
  if (opMatch) {
    if (request.method !== 'POST') {
      return failRes(405, 'method-not-allowed', null, { allow: 'POST' });
    }
    const operation = opMatch[1];
    if (!getOperationSpec(operation)) return failRes(404, 'unknown-operation', operation);
    const raw = await storeCtx.readCapped(request, MAX_OP_BODY_BYTES);
    if (!raw) return failRes(413, 'body-too-large');
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { return failRes(400, 'body-not-json'); }
    try {
      const res = await invokeOntologyOperation(operation, body, {
        loadSnapshot: (cid) => loadSnapshotFromStore(cid, storeCtx),
      });
      return jsonRes(200, res);
    } catch (e) { return errorToResponse(e); }
  }

  return failRes(404, 'not-found');
}
