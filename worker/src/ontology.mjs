// Worker HTTP surface for bounded, read-only, basis-pinned Ontology inspection,
// SQL/SPARQL querying, and Semantic UI Viewer rendering.
//
// Routes under /ontology/v1/:
//   GET  /ontology/v1/schema           -> Semantic UI noun.verb operation catalog & schemas
//   GET  /ontology/v1/inspect/<cid>    -> ontology.inspect for a verified DAG-CBOR snapshot CID
//   GET  /ontology/v1/view/<cid>       -> Semantic UI HTML/SVG/JSON viewer (?format=html|svg|json)
//   POST /ontology/v1/ops/<operation>  -> invoke noun.verb operation (read-only)
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
} from '../../src/ontology-viewer.mjs';

export const ONTOLOGY_PREFIX = '/ontology/v1/';
const MAX_OP_BODY_BYTES = 2 * 1024 * 1024;

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
};

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

async function loadSnapshotFromStore(cid, { readPublicBlock, carLimits, denyHeaders }) {
  const parsed = parseCid(cid);
  if (!parsed || parsed.version !== 1 || parsed.codec !== CODEC_DAG_CBOR || parsed.hashCode !== SHA2_256) {
    throw new LoaderHttpError(400, 'invalid-basis-cid');
  }
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

export async function handleOntology(request, url, { readCapped, readPublicBlock, hasStore, carLimits, denyHeaders }) {
  const path = url.pathname.slice(ONTOLOGY_PREFIX.length);

  if (path === 'schema') {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return failRes(405, 'method-not-allowed', null, { allow: 'GET, HEAD' });
    }
    const body = JSON.stringify(getOntologySchema());
    return new Response(request.method === 'HEAD' ? null : body, {
      status: 200,
      headers: { ...JSON_HEADERS, 'cache-control': 'public, max-age=300' },
    });
  }

  const inspectMatch = /^inspect\/([A-Za-z0-9]+)$/.exec(path);
  if (inspectMatch) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return failRes(405, 'method-not-allowed', null, { allow: 'GET, HEAD' });
    }
    if (!hasStore) return failRes(503, 'store-not-configured');
    try {
      const snapshot = await loadSnapshotFromStore(inspectMatch[1], { readPublicBlock, carLimits, denyHeaders });
      const res = await invokeOntologyOperation('ontology.inspect', { basisCid: snapshot.basisCid }, { snapshot });
      const body = JSON.stringify(res);
      return new Response(request.method === 'HEAD' ? null : body, {
        status: 200,
        headers: { ...JSON_HEADERS, 'cache-control': 'public, max-age=31536000, immutable', etag: `"${snapshot.basisCid}"` },
      });
    } catch (e) {
      return errorToResponse(e);
    }
  }

  const viewMatch = /^view\/([A-Za-z0-9]+)$/.exec(path);
  if (viewMatch) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return failRes(405, 'method-not-allowed', null, { allow: 'GET, HEAD' });
    }
    if (!hasStore) return failRes(503, 'store-not-configured');
    const format = url.searchParams.get('format')
      ?? ((request.headers.get('accept') ?? '').includes('application/json') ? 'json' : 'html');
    if (!['html', 'svg', 'json'].includes(format)) {
      return failRes(400, 'invalid-view-format', 'expected html, svg, or json');
    }
    try {
      const snapshot = await loadSnapshotFromStore(viewMatch[1], { readPublicBlock, carLimits, denyHeaders });
      const rendered = renderOntologyViewer(snapshot, { format, apiBase: '/ontology/v1' });
      if (format === 'html') {
        return new Response(request.method === 'HEAD' ? null : rendered.html, {
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:;",
            'cache-control': 'public, max-age=31536000, immutable',
            etag: `"${snapshot.basisCid}.html"`,
          },
        });
      }
      if (format === 'svg') {
        return new Response(request.method === 'HEAD' ? null : rendered.svg, {
          status: 200,
          headers: {
            'content-type': 'image/svg+xml; charset=utf-8',
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none';",
            'cache-control': 'public, max-age=31536000, immutable',
            etag: `"${snapshot.basisCid}.svg"`,
          },
        });
      }
      return new Response(request.method === 'HEAD' ? null : JSON.stringify(rendered), {
        status: 200,
        headers: { ...JSON_HEADERS, 'cache-control': 'public, max-age=31536000, immutable', etag: `"${snapshot.basisCid}.json"` },
      });
    } catch (e) {
      return errorToResponse(e);
    }
  }

  const opMatch = /^ops\/([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)$/.exec(path);
  if (opMatch) {
    if (request.method !== 'POST') {
      return failRes(405, 'method-not-allowed', null, { allow: 'POST' });
    }
    const operation = opMatch[1];
    if (!getOperationSpec(operation)) return failRes(404, 'unknown-operation', operation);
    const raw = await readCapped(request, MAX_OP_BODY_BYTES);
    if (!raw) return failRes(413, 'body-too-large');
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { return failRes(400, 'body-not-json'); }
    try {
      const res = await invokeOntologyOperation(operation, body, {
        loadSnapshot: async (cid) => {
          if (!hasStore) throw new LoaderHttpError(503, 'store-not-configured');
          return loadSnapshotFromStore(cid, { readPublicBlock, carLimits, denyHeaders });
        },
      });
      return jsonRes(200, res);
    } catch (e) {
      return errorToResponse(e);
    }
  }

  return failRes(404, 'not-found');
}
