// Pure IPLD / DAG-CBOR ontology snapshot store, vocabulary/provenance registry,
// fail-closed JSON-LD/RDF quad ingestion, and relational projection.
//
// Aligns with:
// - kotoba.ontology & kotoba.ontology.connector provenance contracts
//   (:tender, :jurisdiction, :ontology/type, :ontology/source, fail-closed on unregistered connectors)
// - datalog.query required visibility-predicate contract on low-level quad scans
// - AwaiFS IPLD domain-view contract: pinned CIDv1 basis, bounded & read-only,
//   zero implicit network fetch of remote JSON-LD @context.

import { cidFor, cidToBytes, cidFromBytes, parseCid, CODEC_DAG_CBOR, SHA2_256 } from './cid.mjs';
import { encodeDagCbor, decodeDagCbor, linksIn } from './dag-cbor.mjs';
import { checkWritableBlock } from './block.mjs';
import { encodeCarV1, parseCar, CarError } from './car.mjs';
import { linksOf } from './dag.mjs';

export const ONTOLOGY_SNAPSHOT_SCHEMA = 'yataverse.ontology.snapshot/v1';
export const ONTOLOGY_REGISTRY_SCHEMA = 'yataverse.ontology.registry/v1';
export const ONTOLOGY_FACTS_SCHEMA = 'yataverse.ontology.facts/v1';
export const ONTOLOGY_QUADS_SCHEMA = 'yataverse.ontology.quads/v1';
export const ONTOLOGY_JOINS_SCHEMA = 'yataverse.ontology.joins/v1';

export const DEFAULT_BASE_IRI = 'https://awai.network/ns/ontology#';
export const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
export const XSD_NS = 'http://www.w3.org/2001/XMLSchema#';

export const DEFAULT_LIMITS = Object.freeze({
  maxObjectTypes: 256,
  maxConnectors: 256,
  maxFacts: 20_000,
  maxQuads: 100_000,
  maxJoins: 256,
  maxBlocks: 256,
  maxBytes: 16 * 1024 * 1024,
  maxJsonLdDepth: 32,
});

export class OntologyError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'OntologyError';
    this.code = code;
    this.detail = detail ?? null;
  }
}

const bad = (code, detail) => { throw new OntologyError(code, detail); };

/** Normalize EDN-style `:tender` or `:ontology/type` keywords to canonical string keys. */
export function normalizeKeyword(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.startsWith(':') ? trimmed.slice(1) : trimmed;
}

/** Seeded ontology vocabulary registry (kotoba.ontology v1). */
export const DEFAULT_ONTOLOGY_REGISTRY = Object.freeze({
  id: 'kotoba/ontology',
  version: 1,
  objectTypes: Object.freeze([
    Object.freeze({
      id: 'tender',
      name: 'Procurement Tender / Opportunity',
      attributes: Object.freeze({ status: 'keyword' }),
      key: Object.freeze(['status']),
    }),
  ]),
});

/** Seeded external-data connector registry (kotoba.ontology.connector v1). */
export const DEFAULT_CONNECTOR_REGISTRY = Object.freeze({
  id: 'kotoba/ontology-connectors',
  version: 1,
  connectors: Object.freeze([
    Object.freeze({
      id: 'jp.kkj',
      name: 'kkj.go.jp 官公需情報ポータル 検索API',
      objectType: 'tender',
      repo: 'https://github.com/kotoba-lang/goyoukiki',
      status: 'implemented',
    }),
    Object.freeze({
      id: 'jp.geps',
      name: 'GEPS 落札実績オープンデータ',
      objectType: 'tender',
      repo: 'https://github.com/kotoba-lang/goyoukiki',
      status: 'implemented',
    }),
  ]),
});

const PROVENANCE_KEYS = new Set([
  'ontology/type',
  'ontology/source',
  'ontology/fetched-at',
  'ontology/confidence',
]);

function normalizeObjectType(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('invalid-object-type', 'must be an object');
  const id = normalizeKeyword(raw.id);
  if (!id || !/^[a-zA-Z][a-zA-Z0-9._/-]{0,63}$/.test(id)) bad('invalid-object-type-id', String(raw.id));
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id;
  const attrs = {};
  if (raw.attributes !== undefined) {
    if (!raw.attributes || typeof raw.attributes !== 'object' || Array.isArray(raw.attributes)) {
      bad('invalid-object-type-attributes', id);
    }
    for (const [k, v] of Object.entries(raw.attributes)) {
      const nk = normalizeKeyword(k);
      const nv = normalizeKeyword(String(v));
      if (!nk || !nv) bad('invalid-object-type-attribute', `${id}.${k}`);
      attrs[nk] = nv;
    }
  }
  const key = Array.isArray(raw.key)
    ? raw.key.map((k) => {
      const nk = normalizeKeyword(k);
      if (!nk) bad('invalid-object-type-key', id);
      return nk;
    })
    : [];
  return { id, name, attributes: attrs, key };
}

function normalizeConnector(raw, typeIds) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('invalid-connector', 'must be an object');
  const id = normalizeKeyword(raw.id);
  if (!id || !/^[a-zA-Z][a-zA-Z0-9._/-]{0,63}$/.test(id)) bad('invalid-connector-id', String(raw.id));
  const objectType = normalizeKeyword(raw.objectType ?? raw['object-type']);
  if (!objectType) bad('invalid-connector-object-type', id);
  if (typeIds && !typeIds.has(objectType)) bad('unknown-object-type', `${id} -> ${objectType}`);
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id;
  const status = normalizeKeyword(raw.status ?? 'implemented') ?? 'implemented';
  const out = { id, name, objectType, status };
  if (typeof raw.repo === 'string' && raw.repo.trim()) out.repo = raw.repo.trim();
  return out;
}

/** Build a combined ontology + connector registry, seeded with kotoba.ontology defaults unless opted out. */
export function createRegistry({ objectTypes = [], connectors = [], includeDefaults = true } = {}) {
  const typeMap = new Map();
  if (includeDefaults) {
    for (const t of DEFAULT_ONTOLOGY_REGISTRY.objectTypes) {
      typeMap.set(t.id, normalizeObjectType(t));
    }
  }
  for (const t of objectTypes) {
    const nt = normalizeObjectType(t);
    typeMap.set(nt.id, nt);
  }
  const typeIds = new Set(typeMap.keys());
  const connectorMap = new Map();
  if (includeDefaults) {
    for (const c of DEFAULT_CONNECTOR_REGISTRY.connectors) {
      if (typeIds.has(c.objectType)) connectorMap.set(c.id, normalizeConnector(c, typeIds));
    }
  }
  for (const c of connectors) {
    const nc = normalizeConnector(c, typeIds);
    connectorMap.set(nc.id, nc);
  }
  return {
    schema: ONTOLOGY_REGISTRY_SCHEMA,
    version: 1,
    objectTypes: [...typeMap.values()].sort((a, b) => a.id.localeCompare(b.id)),
    connectors: [...connectorMap.values()].sort((a, b) => a.id.localeCompare(b.id)),
    objectTypesById: typeMap,
    connectorsById: connectorMap,
  };
}

function normalizeFactKeys(fact) {
  if (!fact || typeof fact !== 'object' || Array.isArray(fact)) bad('invalid-fact', 'fact must be an object');
  const out = {};
  for (const [k, v] of Object.entries(fact)) {
    if (v === undefined) continue;
    const nk = normalizeKeyword(k) ?? k;
    out[nk] = v;
  }
  return out;
}

/** Structural conformance check (kotoba.ontology/conforms?): fact has every attribute declared for typeId. */
export function conforms(registry, typeId, fact) {
  const reg = registry?.objectTypesById ? registry : createRegistry(registry ?? {});
  const id = normalizeKeyword(typeId);
  const type = reg.objectTypesById.get(id);
  if (!type) return false;
  const nf = normalizeFactKeys(fact);
  for (const attrKey of Object.keys(type.attributes)) {
    if (!Object.prototype.hasOwnProperty.call(nf, attrKey)) return false;
  }
  return true;
}

/**
 * Stamp ontology provenance onto a normalized fact (kotoba.ontology.connector/tag).
 * Fails closed on an unregistered connectorId.
 */
export function tagFact(connectorId, fact, { registry = createRegistry(), fetchedAt, confidence } = {}) {
  const reg = registry?.connectorsById ? registry : createRegistry(registry ?? {});
  const cid = normalizeKeyword(connectorId);
  const connector = cid ? reg.connectorsById.get(cid) : null;
  if (!connector) {
    bad('unregistered-connector', `${String(connectorId)} (known: ${[...reg.connectorsById.keys()].join(', ')})`);
  }
  const nf = normalizeFactKeys(fact);
  const tagged = {
    ...nf,
    'ontology/type': connector.objectType,
    'ontology/source': connector.id,
  };
  if (fetchedAt !== undefined && fetchedAt !== null) tagged['ontology/fetched-at'] = String(fetchedAt);
  if (confidence !== undefined && confidence !== null) {
    if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      bad('invalid-confidence', String(confidence));
    }
    tagged['ontology/confidence'] = confidence;
  }
  return tagged;
}

/**
 * True when `fact` carries valid :ontology/* provenance from registered `connectorId`
 * and structurally conforms to the connector's objectType.
 */
export function taggedConforms(registry, connectorId, fact) {
  const reg = registry?.connectorsById ? registry : createRegistry(registry ?? {});
  const cid = normalizeKeyword(connectorId);
  const connector = cid ? reg.connectorsById.get(cid) : null;
  if (!connector) return false;
  const nf = normalizeFactKeys(fact);
  if (normalizeKeyword(nf['ontology/type']) !== connector.objectType) return false;
  if (normalizeKeyword(nf['ontology/source']) !== connector.id) return false;
  const stripped = {};
  for (const [k, v] of Object.entries(nf)) {
    if (!PROVENANCE_KEYS.has(k)) stripped[k] = v;
  }
  return conforms(reg, connector.objectType, stripped);
}

// --- Canonical DAG-CBOR value encoding / decoding helpers ---
// src/dag-cbor.mjs intentionally refuses floats so integers never silently become floats.
// Non-integer finite numbers use a versioned typed wrapper {$awaiType:'decimal', value:'...'}.

export function toDagCborSafe(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) bad('non-finite-number', String(value));
    if (Number.isSafeInteger(value)) return value;
    return { $awaiType: 'decimal', value: String(value) };
  }
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map(toDagCborSafe);
  if (value && typeof value === 'object') {
    if (Object.keys(value).length === 1 && value.cid instanceof Uint8Array) return value;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = toDagCborSafe(v);
    }
    return out;
  }
  bad('value-not-dag-cbor-safe', typeof value);
}

export function fromDagCborSafe(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'bigint') {
    if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(value);
    }
    return value.toString();
  }
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map(fromDagCborSafe);
  if (value instanceof Map) {
    if (value.size === 2 && value.get('$awaiType') === 'decimal' && typeof value.get('value') === 'string') {
      const n = Number(value.get('value'));
      if (!Number.isFinite(n)) bad('invalid-decimal-wrapper', value.get('value'));
      return n;
    }
    const out = {};
    for (const [k, v] of value.entries()) out[k] = fromDagCborSafe(v);
    return out;
  }
  if (value && typeof value === 'object') {
    if (Object.keys(value).length === 1 && value.cid instanceof Uint8Array) return value;
    if (value.$awaiType === 'decimal' && typeof value.value === 'string') {
      const n = Number(value.value);
      if (!Number.isFinite(n)) bad('invalid-decimal-wrapper', value.value);
      return n;
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = fromDagCborSafe(v);
    return out;
  }
  return value;
}

// --- RDF Terms & Quads ---

export function iriTerm(value) {
  if (typeof value !== 'string' || !value.trim()) bad('invalid-iri-term', String(value));
  return { rdfType: 'iri', value: value.trim() };
}

export function bnodeTerm(value) {
  if (typeof value !== 'string' || !value.trim()) bad('invalid-bnode-term', String(value));
  const v = value.trim().startsWith('_:') ? value.trim() : `_:${value.trim()}`;
  return { rdfType: 'bnode', value: v };
}

export function literalTerm(value, { datatype, language } = {}) {
  if (value === null || value === undefined) bad('invalid-literal-term', 'null/undefined');
  const out = { rdfType: 'literal', value };
  if (language) {
    out.language = String(language);
    out.datatype = `${RDF_TYPE.slice(0, -4)}langString`;
  } else if (datatype) {
    out.datatype = String(datatype);
  } else if (typeof value === 'boolean') {
    out.datatype = `${XSD_NS}boolean`;
  } else if (typeof value === 'number') {
    out.datatype = Number.isInteger(value) ? `${XSD_NS}integer` : `${XSD_NS}decimal`;
  } else {
    out.datatype = `${XSD_NS}string`;
  }
  return out;
}

export function normalizeRdfTerm(term, { role = 'object' } = {}) {
  if (term && typeof term === 'object' && !Array.isArray(term)) {
    const t = term.rdfType ?? normalizeKeyword(term['rdf/type']);
    if (t === 'iri') return iriTerm(term.value);
    if (t === 'bnode') return bnodeTerm(term.value);
    if (t === 'literal') return literalTerm(term.value, { datatype: term.datatype, language: term.language });
    if (typeof term['@id'] === 'string') return term['@id'].startsWith('_:') ? bnodeTerm(term['@id']) : iriTerm(term['@id']);
    if (Object.prototype.hasOwnProperty.call(term, '@value')) {
      return literalTerm(term['@value'], { datatype: term['@type'], language: term['@language'] });
    }
    bad('invalid-rdf-term', JSON.stringify(term).slice(0, 120));
  }
  if (typeof term === 'string') {
    if (term.startsWith('_:')) return bnodeTerm(term);
    if (role === 'subject' || role === 'predicate' || role === 'graph') {
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(term)) return iriTerm(term);
      return iriTerm(`${DEFAULT_BASE_IRI}${encodeURIComponent(term)}`);
    }
    if (/^(https?|urn|did|ipfs|ipld):/.test(term)) return iriTerm(term);
    return literalTerm(term);
  }
  if (typeof term === 'number' || typeof term === 'boolean') {
    if (role !== 'object') bad('invalid-rdf-term', `${role} cannot be ${typeof term}`);
    return literalTerm(term);
  }
  bad('invalid-rdf-term', String(term));
}

export function normalizeQuad(q) {
  if (!q || typeof q !== 'object' || Array.isArray(q)) bad('invalid-quad', 'must be an object');
  const subject = normalizeRdfTerm(q.subject ?? q.s, { role: 'subject' });
  const predicate = normalizeRdfTerm(q.predicate ?? q.p, { role: 'predicate' });
  const object = normalizeRdfTerm(q.object ?? q.o, { role: 'object' });
  if (subject.rdfType === 'literal') bad('invalid-quad', 'subject cannot be a literal');
  if (predicate.rdfType !== 'iri') bad('invalid-quad', 'predicate must be an IRI');
  const out = { subject, predicate, object };
  if (q.graph !== undefined && q.graph !== null) {
    const graph = normalizeRdfTerm(q.graph, { role: 'graph' });
    if (graph.rdfType === 'literal') bad('invalid-quad', 'graph cannot be a literal');
    out.graph = graph;
  }
  return out;
}

export function rdfTermKey(term) {
  if (!term) return '';
  if (term.rdfType === 'iri') return `I:${term.value}`;
  if (term.rdfType === 'bnode') return `B:${term.value}`;
  return `L:${JSON.stringify(term.value)}:${term.datatype ?? ''}:${term.language ?? ''}`;
}

export function rdfTermsEqual(a, b) {
  if (!a || !b) return false;
  if (a.rdfType !== b.rdfType) return false;
  if (a.rdfType === 'iri' || a.rdfType === 'bnode') return a.value === b.value;
  return a.value === b.value && (a.language ?? null) === (b.language ?? null) && (a.datatype ?? null) === (b.datatype ?? null);
}

// --- Fail-closed JSON-LD Ingestion (NO remote @context fetching) ---

const REMOTE_IRI_RE = /^(?:https?|ftp|file|ipfs|ipns):\/\//i;

function resolvePinnedContext(ref, pinnedContexts) {
  if (typeof ref !== 'string') bad('invalid-jsonld-context', 'context reference must be a string or object');
  const map = pinnedContexts instanceof Map ? pinnedContexts : new Map(Object.entries(pinnedContexts ?? {}));
  if (!map.has(ref)) {
    bad('remote-context-refused', `unpinned JSON-LD @context "${ref}" (network fetch is disabled; pass pinnedContexts)`);
  }
  const entry = map.get(ref);
  if (!entry || typeof entry !== 'object') bad('invalid-pinned-context', ref);
  // Optional CID pinning verification for pinned contexts
  if (entry.cid !== undefined) {
    const ctxObj = entry.context ?? entry;
    const bytes = encodeDagCbor(toDagCborSafe(ctxObj));
    const actualCid = cidFor(bytes, CODEC_DAG_CBOR);
    if (actualCid !== entry.cid) {
      bad('pinned-context-cid-mismatch', `${ref}: expected ${entry.cid}, got ${actualCid}`);
    }
    return ctxObj;
  }
  return entry.context && typeof entry.context === 'object' ? entry.context : entry;
}

function mergeContext(baseCtx, rawCtx, pinnedContexts, depth = 0) {
  if (depth > 8) bad('jsonld-context-too-deep', String(depth));
  if (rawCtx === null) return { vocab: null, base: null, prefixes: {}, terms: {} };
  if (Array.isArray(rawCtx)) {
    let cur = baseCtx;
    for (const item of rawCtx) cur = mergeContext(cur, item, pinnedContexts, depth + 1);
    return cur;
  }
  if (typeof rawCtx === 'string') {
    const resolved = resolvePinnedContext(rawCtx, pinnedContexts);
    return mergeContext(baseCtx, resolved, pinnedContexts, depth + 1);
  }
  if (typeof rawCtx !== 'object') bad('invalid-jsonld-context', typeof rawCtx);

  const next = {
    vocab: baseCtx.vocab,
    base: baseCtx.base,
    prefixes: { ...baseCtx.prefixes },
    terms: { ...baseCtx.terms },
  };
  if (Object.prototype.hasOwnProperty.call(rawCtx, '@import')) {
    const imp = resolvePinnedContext(rawCtx['@import'], pinnedContexts);
    const mergedImp = mergeContext(next, imp, pinnedContexts, depth + 1);
    Object.assign(next, mergedImp);
  }
  if (Object.prototype.hasOwnProperty.call(rawCtx, '@vocab')) {
    next.vocab = rawCtx['@vocab'] === null ? null : String(rawCtx['@vocab']);
  }
  if (Object.prototype.hasOwnProperty.call(rawCtx, '@base')) {
    next.base = rawCtx['@base'] === null ? null : String(rawCtx['@base']);
  }
  for (const [k, v] of Object.entries(rawCtx)) {
    if (k.startsWith('@')) continue;
    if (typeof v === 'string') {
      if (v.endsWith('#') || v.endsWith('/') || v.endsWith(':')) next.prefixes[k] = v;
      next.terms[k] = { id: v, type: null };
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      next.terms[k] = {
        id: typeof v['@id'] === 'string' ? v['@id'] : null,
        type: typeof v['@type'] === 'string' ? v['@type'] : null,
        language: typeof v['@language'] === 'string' ? v['@language'] : null,
      };
    } else if (v === null) {
      delete next.prefixes[k];
      delete next.terms[k];
    } else {
      bad('invalid-jsonld-context-entry', k);
    }
  }
  return next;
}

function expandIri(value, ctx, { vocab = false } = {}) {
  if (typeof value !== 'string' || !value.trim()) bad('invalid-jsonld-iri', String(value));
  const v = value.trim();
  if (v.startsWith('_:')) return v;
  if (ctx.terms[v]?.id) return expandIri(ctx.terms[v].id, ctx, { vocab: true });
  const colon = v.indexOf(':');
  if (colon > 0) {
    const prefix = v.slice(0, colon);
    const suffix = v.slice(colon + 1);
    if (prefix === '_') return v;
    if (ctx.prefixes[prefix]) return `${ctx.prefixes[prefix]}${suffix}`;
    if (ctx.terms[prefix]?.id && !suffix.startsWith('//')) return `${ctx.terms[prefix].id}${suffix}`;
    return v; // full IRI (e.g. https://..., urn:..., did:...)
  }
  if (vocab && ctx.vocab) return `${ctx.vocab}${v}`;
  if (!vocab && ctx.base) {
    try { return new URL(v, ctx.base).toString(); } catch { /* fall through */ }
  }
  return `${DEFAULT_BASE_IRI}${encodeURIComponent(v)}`;
}

/**
 * Ingest a JSON-LD document into canonical RDF quads.
 * Remote `@context` URLs are refused unless explicitly supplied in `pinnedContexts`.
 */
export function ingestJsonLd(input, { pinnedContexts = {}, defaultGraph = null, maxQuads = DEFAULT_LIMITS.maxQuads } = {}) {
  const doc = typeof input === 'string' ? JSON.parse(input) : input;
  if (!doc || typeof doc !== 'object') bad('invalid-jsonld', 'document must be an object or array');

  const quads = [];
  let bnodeCounter = 0;
  const nextBnode = () => bnodeTerm(`_:b${++bnodeCounter}`);
  const rootCtx = { vocab: null, base: null, prefixes: { rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#', xsd: XSD_NS }, terms: {} };

  const pushQuad = (subject, predicate, object, graph) => {
    if (quads.length >= maxQuads) bad('limit-exceeded', `maxQuads (${maxQuads})`);
    quads.push(normalizeQuad({ subject, predicate, object, ...(graph ? { graph } : {}) }));
  };

  function visitNode(node, parentCtx, graphTerm, depth) {
    if (depth > DEFAULT_LIMITS.maxJsonLdDepth) bad('jsonld-too-deep', String(depth));
    if (Array.isArray(node)) {
      for (const item of node) visitNode(item, parentCtx, graphTerm, depth + 1);
      return null;
    }
    if (!node || typeof node !== 'object') bad('invalid-jsonld-node', typeof node);
    const ctx = Object.prototype.hasOwnProperty.call(node, '@context')
      ? mergeContext(parentCtx, node['@context'], pinnedContexts)
      : parentCtx;

    if (Object.prototype.hasOwnProperty.call(node, '@graph')) {
      const gTerm = node['@id']
        ? (String(node['@id']).startsWith('_:') ? bnodeTerm(node['@id']) : iriTerm(expandIri(node['@id'], ctx)))
        : graphTerm;
      visitNode(node['@graph'], ctx, gTerm, depth + 1);
      return gTerm;
    }

    const subj = node['@id']
      ? (String(node['@id']).startsWith('_:') ? bnodeTerm(node['@id']) : iriTerm(expandIri(node['@id'], ctx)))
      : nextBnode();

    if (node['@type'] !== undefined) {
      const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
      for (const t of types) {
        pushQuad(subj, iriTerm(RDF_TYPE), iriTerm(expandIri(t, ctx, { vocab: true })), graphTerm);
      }
    }

    for (const [k, rawVal] of Object.entries(node)) {
      if (k.startsWith('@')) continue;
      const predIri = expandIri(k, ctx, { vocab: true });
      const termDef = ctx.terms[k] ?? null;
      const pred = iriTerm(predIri);
      const values = Array.isArray(rawVal) ? rawVal : [rawVal];
      for (const val of values) {
        if (val === null || val === undefined) continue;
        if (typeof val === 'object' && !Array.isArray(val)) {
          if (Object.prototype.hasOwnProperty.call(val, '@value')) {
            const dt = val['@type'] ? expandIri(val['@type'], ctx, { vocab: true }) : undefined;
            const obj = literalTerm(val['@value'], { datatype: dt, language: val['@language'] });
            pushQuad(subj, pred, obj, graphTerm);
          } else {
            const child = visitNode(val, ctx, graphTerm, depth + 1);
            if (child) pushQuad(subj, pred, child, graphTerm);
          }
        } else if (typeof val === 'string' && termDef?.type === '@id') {
          const target = val.startsWith('_:') ? bnodeTerm(val) : iriTerm(expandIri(val, ctx));
          pushQuad(subj, pred, target, graphTerm);
        } else if (typeof val === 'string' && REMOTE_IRI_RE.test(val) && !termDef?.type) {
          pushQuad(subj, pred, literalTerm(val, { language: termDef?.language }), graphTerm);
        } else {
          const dt = termDef?.type && termDef.type !== '@id' ? expandIri(termDef.type, ctx, { vocab: true }) : undefined;
          pushQuad(subj, pred, literalTerm(val, { datatype: dt, language: termDef?.language }), graphTerm);
        }
      }
    }
    return subj;
  }

  const graphTerm = defaultGraph ? normalizeRdfTerm(defaultGraph, { role: 'graph' }) : null;
  visitNode(doc, rootCtx, graphTerm, 0);
  return quads;
}

/** Project one normalized, provenance-tagged fact into canonical RDF quads. */
export function factToQuads(fact, { baseIri = DEFAULT_BASE_IRI, defaultGraph = null } = {}) {
  const nf = normalizeFactKeys(fact);
  const typeId = normalizeKeyword(nf['ontology/type']);
  if (!typeId) bad('fact-missing-ontology-type', JSON.stringify(nf).slice(0, 120));
  const entityId = nf.id !== undefined ? String(nf.id) : null;
  if (!entityId) bad('fact-missing-id', typeId);
  const subj = nf.iri
    ? iriTerm(String(nf.iri))
    : iriTerm(`${baseIri}entity/${encodeURIComponent(typeId)}/${encodeURIComponent(entityId)}`);
  const graph = defaultGraph ? normalizeRdfTerm(defaultGraph, { role: 'graph' }) : null;
  const quads = [
    normalizeQuad({ subject: subj, predicate: iriTerm(RDF_TYPE), object: iriTerm(`${baseIri}${encodeURIComponent(typeId)}`), ...(graph ? { graph } : {}) }),
  ];
  for (const [k, v] of Object.entries(nf)) {
    if (k === 'iri' || v === undefined || v === null) continue;
    const pred = iriTerm(`${baseIri}${k.replace(/\//g, '.')}`);
    const values = Array.isArray(v) ? v : [v];
    for (const item of values) {
      if (item === null || item === undefined) continue;
      let obj;
      if (typeof item === 'object' && !Array.isArray(item) && (item.rdfType || item['@id'] || Object.prototype.hasOwnProperty.call(item, '@value'))) {
        obj = normalizeRdfTerm(item, { role: 'object' });
      } else if (typeof item === 'string' && /^(https?|urn|did|ipfs|ipld):/.test(item)) {
        obj = iriTerm(item);
      } else if (typeof item === 'object') {
        obj = literalTerm(JSON.stringify(item));
      } else {
        obj = literalTerm(item);
      }
      quads.push(normalizeQuad({ subject: subj, predicate: pred, object: obj, ...(graph ? { graph } : {}) }));
    }
  }
  return quads;
}

function normalizeJoinMapping(raw, typeIds) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('invalid-join-mapping', 'must be an object');
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name || !/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(name)) bad('invalid-join-name', String(raw.name));
  const leftType = normalizeKeyword(raw.leftType ?? raw.left_type);
  const rightType = normalizeKeyword(raw.rightType ?? raw.right_type);
  const leftKey = normalizeKeyword(raw.leftKey ?? raw.left_key);
  const rightKey = normalizeKeyword(raw.rightKey ?? raw.right_key);
  const kind = (raw.kind ?? 'inner').toLowerCase();
  if (!leftType || !rightType || !leftKey || !rightKey) bad('invalid-join-mapping', name);
  if (kind !== 'inner' && kind !== 'left') bad('invalid-join-kind', kind);
  if (typeIds && (!typeIds.has(leftType) || !typeIds.has(rightType))) {
    bad('join-references-unknown-type', `${name}: ${leftType} / ${rightType}`);
  }
  return { name, leftType, rightType, leftKey, rightKey, kind };
}

function dedupeAndSortQuads(quads) {
  const seen = new Map();
  for (const q of quads) {
    const k = `${rdfTermKey(q.subject)}|${rdfTermKey(q.predicate)}|${rdfTermKey(q.object)}|${rdfTermKey(q.graph)}`;
    if (!seen.has(k)) seen.set(k, q);
  }
  return [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, q]) => q);
}

/** Project a verified ontology snapshot into read-only relational tables for SQL queries. */
export function projectTables(snapshot) {
  const tables = new Map();
  const addTable = (name, rows) => { tables.set(name.toLowerCase(), { name, rows }); };

  const factsByType = new Map();
  for (const t of snapshot.registry.objectTypes) factsByType.set(t.id, []);
  const allFactRows = [];
  for (const f of snapshot.facts) {
    const row = {
      id: f.id,
      ontology_type: f['ontology/type'],
      ontology_source: f['ontology/source'],
      ontology_fetched_at: f['ontology/fetched-at'] ?? null,
      ontology_confidence: f['ontology/confidence'] ?? null,
    };
    for (const [k, v] of Object.entries(f)) {
      if (k === 'id' || PROVENANCE_KEYS.has(k)) continue;
      const col = k.replace(/[./-]/g, '_');
      row[col] = v;
    }
    allFactRows.push(row);
    const list = factsByType.get(f['ontology/type']) ?? [];
    list.push(row);
    factsByType.set(f['ontology/type'], list);
  }

  for (const [typeId, rows] of factsByType.entries()) {
    addTable(typeId, rows);
    const normalized = typeId.replace(/[./-]/g, '_');
    if (normalized !== typeId) addTable(normalized, rows);
  }

  addTable('ontology_facts', allFactRows);
  addTable('ontology_quads', snapshot.quads.map((q) => ({
    subject: q.subject.value,
    subject_type: q.subject.rdfType,
    predicate: q.predicate.value,
    object: q.object.value,
    object_type: q.object.rdfType,
    datatype: q.object.datatype ?? null,
    language: q.object.language ?? null,
    graph: q.graph?.value ?? null,
  })));
  addTable('ontology_types', snapshot.registry.objectTypes.map((t) => ({
    id: t.id,
    name: t.name,
    required_attributes: Object.keys(t.attributes).sort().join(','),
    key_attributes: t.key.join(','),
  })));
  addTable('ontology_connectors', snapshot.registry.connectors.map((c) => ({
    id: c.id,
    name: c.name,
    object_type: c.objectType,
    repo: c.repo ?? null,
    status: c.status,
  })));
  addTable('ontology_joins', snapshot.joinMappings.map((j) => ({
    name: j.name,
    left_type: j.leftType,
    right_type: j.rightType,
    left_key: j.leftKey,
    right_key: j.rightKey,
    kind: j.kind,
  })));

  // Materialize declared join mappings as read-only join views as well.
  for (const j of snapshot.joinMappings) {
    const leftRows = tables.get(j.leftType.toLowerCase())?.rows ?? [];
    const rightRows = tables.get(j.rightType.toLowerCase())?.rows ?? [];
    const lk = j.leftKey.replace(/[./-]/g, '_');
    const rk = j.rightKey.replace(/[./-]/g, '_');
    const rightIndex = new Map();
    for (const r of rightRows) {
      const val = r[rk];
      if (val === undefined || val === null) continue;
      const key = String(val);
      const bucket = rightIndex.get(key) ?? [];
      bucket.push(r);
      rightIndex.set(key, bucket);
    }
    const joined = [];
    for (const l of leftRows) {
      const lval = l[lk];
      const matches = lval !== undefined && lval !== null ? (rightIndex.get(String(lval)) ?? []) : [];
      if (matches.length === 0) {
        if (j.kind === 'left') {
          const row = {};
          for (const [k, v] of Object.entries(l)) row[`${j.leftType}_${k}`] = v;
          joined.push(row);
        }
      } else {
        for (const r of matches) {
          const row = {};
          for (const [k, v] of Object.entries(l)) row[`${j.leftType}_${k}`] = v;
          for (const [k, v] of Object.entries(r)) row[`${j.rightType}_${k}`] = v;
          joined.push(row);
        }
      }
    }
    if (!tables.has(j.name.toLowerCase())) addTable(j.name, joined);
  }

  return tables;
}

function encodeBlock(payload) {
  const bytes = encodeDagCbor(toDagCborSafe(payload));
  const cid = cidFor(bytes, CODEC_DAG_CBOR);
  const badBlock = checkWritableBlock(cid, bytes);
  if (badBlock) bad('invalid-dag-cbor-block', badBlock);
  return { cid, bytes };
}

/**
 * Build a canonical multi-block DAG-CBOR IPLD ontology snapshot with tag-42 CID links.
 * Returns { basisCid, rootCid, id, blocks, blockList, carBytes, registry, facts, quads, joinMappings, tables, stats }.
 */
export function buildOntologySnapshot(input = {}, opts = {}) {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : 'default';
  const baseIri = typeof input.baseIri === 'string' && input.baseIri.trim() ? input.baseIri.trim() : DEFAULT_BASE_IRI;

  const registry = createRegistry({
    objectTypes: input.objectTypes ?? [],
    connectors: input.connectors ?? [],
    includeDefaults: input.includeDefaults !== false,
  });
  if (registry.objectTypes.length > limits.maxObjectTypes) bad('limit-exceeded', 'maxObjectTypes');
  if (registry.connectors.length > limits.maxConnectors) bad('limit-exceeded', 'maxConnectors');

  const rawFacts = Array.isArray(input.facts) ? input.facts : [];
  if (rawFacts.length > limits.maxFacts) bad('limit-exceeded', `maxFacts (${limits.maxFacts})`);

  const normalizedFacts = [];
  const factQuads = [];
  for (let i = 0; i < rawFacts.length; i++) {
    const raw = normalizeFactKeys(rawFacts[i]);
    const connectorId = normalizeKeyword(raw.connectorId ?? raw['ontology/source']);
    if (!connectorId) bad('missing-connector-provenance', `fact[${i}] requires connectorId or ontology/source`);
    const factCopy = { ...raw };
    delete factCopy.connectorId;
    if (factCopy.id === undefined || factCopy.id === null || String(factCopy.id).trim() === '') {
      factCopy.id = `fact-${i + 1}`;
    } else {
      factCopy.id = String(factCopy.id);
    }
    const tagged = tagFact(connectorId, factCopy, {
      registry,
      fetchedAt: factCopy['ontology/fetched-at'],
      confidence: factCopy['ontology/confidence'],
    });
    if (raw['ontology/type'] !== undefined && normalizeKeyword(raw['ontology/type']) !== tagged['ontology/type']) {
      bad('ontology-type-mismatch', `fact[${i}] declared ${raw['ontology/type']} but connector ${connectorId} produces ${tagged['ontology/type']}`);
    }
    if (!taggedConforms(registry, connectorId, tagged)) {
      bad('fact-does-not-conform', `fact[${i}] (${tagged.id}) does not conform to objectType "${tagged['ontology/type']}"`);
    }
    normalizedFacts.push(tagged);
    factQuads.push(...factToQuads(tagged, { baseIri }));
  }

  // Sort facts deterministically by (ontology/type, id) so identical data yields identical CIDs.
  normalizedFacts.sort((a, b) => {
    const t = String(a['ontology/type']).localeCompare(String(b['ontology/type']));
    return t !== 0 ? t : String(a.id).localeCompare(String(b.id));
  });

  const explicitQuads = [];
  if (Array.isArray(input.quads)) {
    for (const q of input.quads) explicitQuads.push(normalizeQuad(q));
  }
  const jsonLdDocs = input.jsonLd === undefined ? [] : (Array.isArray(input.jsonLd) ? input.jsonLd : [input.jsonLd]);
  for (const doc of jsonLdDocs) {
    const ingested = ingestJsonLd(doc, { pinnedContexts: input.pinnedContexts ?? {}, maxQuads: limits.maxQuads });
    explicitQuads.push(...ingested);
  }

  const allQuads = dedupeAndSortQuads([...factQuads, ...explicitQuads]);
  if (allQuads.length > limits.maxQuads) bad('limit-exceeded', `maxQuads (${limits.maxQuads})`);

  const rawJoins = Array.isArray(input.joinMappings) ? input.joinMappings : [];
  if (rawJoins.length > limits.maxJoins) bad('limit-exceeded', `maxJoins (${limits.maxJoins})`);
  const typeIds = new Set(registry.objectTypes.map((t) => t.id));
  const joinMappings = rawJoins
    .map((j) => normalizeJoinMapping(j, typeIds))
    .sort((a, b) => a.name.localeCompare(b.name));

  let parentBasisCid = null;
  if (input.basisCid !== undefined && input.basisCid !== null) {
    const p = parseCid(input.basisCid);
    if (!p || p.version !== 1 || p.hashCode !== SHA2_256) bad('invalid-basis-cid', String(input.basisCid));
    parentBasisCid = input.basisCid;
  }

  // Encode child DAG-CBOR blocks
  const registryBlock = encodeBlock({
    schema: ONTOLOGY_REGISTRY_SCHEMA,
    version: 1,
    objectTypes: registry.objectTypes,
    connectors: registry.connectors,
  });
  const factsBlock = encodeBlock({
    schema: ONTOLOGY_FACTS_SCHEMA,
    version: 1,
    facts: normalizedFacts,
  });
  const quadsBlock = encodeBlock({
    schema: ONTOLOGY_QUADS_SCHEMA,
    version: 1,
    quads: allQuads,
  });
  const joinsBlock = encodeBlock({
    schema: ONTOLOGY_JOINS_SCHEMA,
    version: 1,
    joinMappings,
  });

  const stats = {
    objectTypes: registry.objectTypes.length,
    connectors: registry.connectors.length,
    facts: normalizedFacts.length,
    quads: allQuads.length,
    joins: joinMappings.length,
  };

  const rootPayload = {
    schema: ONTOLOGY_SNAPSHOT_SCHEMA,
    version: 1,
    id,
    baseIri,
    registry: { cid: cidToBytes(registryBlock.cid) },
    facts: { cid: cidToBytes(factsBlock.cid) },
    quads: { cid: cidToBytes(quadsBlock.cid) },
    joins: { cid: cidToBytes(joinsBlock.cid) },
    stats,
  };
  if (input.createdAt !== undefined && input.createdAt !== null) {
    rootPayload.createdAt = String(input.createdAt);
  }
  if (parentBasisCid) {
    rootPayload.parentBasis = { cid: cidToBytes(parentBasisCid) };
  }

  const rootBlock = encodeBlock(rootPayload);
  const blockList = [rootBlock, registryBlock, factsBlock, quadsBlock, joinsBlock];
  const blocks = new Map();
  let totalBytes = 0;
  for (const b of blockList) {
    if (!blocks.has(b.cid)) {
      blocks.set(b.cid, b.bytes);
      totalBytes += b.bytes.length;
    }
  }
  if (blocks.size > limits.maxBlocks) bad('limit-exceeded', `maxBlocks (${limits.maxBlocks})`);
  if (totalBytes > limits.maxBytes) bad('limit-exceeded', `maxBytes (${limits.maxBytes})`);

  const carBytes = encodeCarV1([rootBlock.cid], [...blocks.entries()].map(([cid, bytes]) => ({ cid, bytes })));

  const snapshot = {
    schema: ONTOLOGY_SNAPSHOT_SCHEMA,
    version: 1,
    id,
    baseIri,
    createdAt: rootPayload.createdAt ?? null,
    parentBasisCid,
    basisCid: rootBlock.cid,
    rootCid: rootBlock.cid,
    blockCids: {
      root: rootBlock.cid,
      registry: registryBlock.cid,
      facts: factsBlock.cid,
      quads: quadsBlock.cid,
      joins: joinsBlock.cid,
    },
    blocks,
    blockList: [...blocks.entries()].map(([cid, bytes]) => ({ cid, bytes })),
    carBytes,
    registry,
    facts: normalizedFacts,
    quads: allQuads,
    joinMappings,
    stats,
  };
  snapshot.tables = projectTables(snapshot);
  return snapshot;
}

function extractLinkCid(val, fieldName) {
  if (!val || typeof val !== 'object' || !(val.cid instanceof Uint8Array)) {
    bad('missing-cid-link', fieldName);
  }
  const cid = cidFromBytes(val.cid);
  if (!cid) bad('invalid-cid-link', fieldName);
  return cid;
}

/**
 * Verify an IPLD DAG-CBOR ontology snapshot from a CARv1/CARv2 buffer, a Map<cid, bytes>, or [{cid, bytes}].
 * Checks CIDv1 sha2-256 digests, canonical DAG-CBOR, complete closure, schema, and provenance conformance.
 */
export function verifyOntologySnapshot(blocksOrCar, { expectedBasisCid = null, rootCid = null, limits: customLimits = {} } = {}) {
  const limits = { ...DEFAULT_LIMITS, ...customLimits };
  const blocks = new Map();
  let resolvedRoot = rootCid;

  if (blocksOrCar instanceof Uint8Array || Buffer.isBuffer(blocksOrCar)) {
    if (blocksOrCar.length > limits.maxBytes) bad('limit-exceeded', `maxBytes (${limits.maxBytes})`);
    let car;
    try { car = parseCar(blocksOrCar, { maxBlocks: limits.maxBlocks }); }
    catch (e) { if (e instanceof CarError) bad(`car-${e.code}`, e.message); throw e; }
    if (car.roots.length !== 1) bad('expected-single-root', String(car.roots.length));
    resolvedRoot ??= car.roots[0];
    if (resolvedRoot !== car.roots[0]) bad('root-cid-mismatch', `${resolvedRoot} !== ${car.roots[0]}`);
    for (const b of car.blocks) blocks.set(b.cid, b.bytes);
  } else if (blocksOrCar instanceof Map) {
    for (const [cid, bytes] of blocksOrCar.entries()) blocks.set(cid, bytes);
  } else if (Array.isArray(blocksOrCar)) {
    for (const b of blocksOrCar) blocks.set(b.cid, b.bytes);
  } else {
    bad('invalid-snapshot-input', 'expected CAR bytes, Map, or block list');
  }

  if (!resolvedRoot) bad('missing-root-cid', 'rootCid is required when input is not a CAR');
  if (expectedBasisCid && resolvedRoot !== expectedBasisCid) {
    bad('basis-cid-mismatch', `expected ${expectedBasisCid}, got ${resolvedRoot}`);
  }

  const parsedRoot = parseCid(resolvedRoot);
  if (!parsedRoot || parsedRoot.version !== 1 || parsedRoot.codec !== CODEC_DAG_CBOR || parsedRoot.hashCode !== SHA2_256) {
    bad('invalid-root-cid', resolvedRoot);
  }
  if (blocks.size > limits.maxBlocks) bad('limit-exceeded', `maxBlocks (${limits.maxBlocks})`);

  let totalBytes = 0;
  for (const [cid, bytes] of blocks.entries()) {
    totalBytes += bytes.length;
    if (totalBytes > limits.maxBytes) bad('limit-exceeded', `maxBytes (${limits.maxBytes})`);
    const err = checkWritableBlock(cid, bytes);
    if (err) bad('invalid-block', `${cid}: ${err}`);
  }
  if (!blocks.has(resolvedRoot)) bad('root-block-missing', resolvedRoot);

  // Verify complete DAG closure starting at resolvedRoot (parentBasis is optional external link)
  const rootDecoded = fromDagCborSafe(decodeDagCbor(blocks.get(resolvedRoot)).value);
  if (!rootDecoded || typeof rootDecoded !== 'object' || rootDecoded.schema !== ONTOLOGY_SNAPSHOT_SCHEMA || rootDecoded.version !== 1) {
    bad('invalid-snapshot-schema', String(rootDecoded?.schema));
  }

  const registryCid = extractLinkCid(rootDecoded.registry, 'registry');
  const factsCid = extractLinkCid(rootDecoded.facts, 'facts');
  const quadsCid = extractLinkCid(rootDecoded.quads, 'quads');
  const joinsCid = extractLinkCid(rootDecoded.joins, 'joins');
  const parentBasisCid = rootDecoded.parentBasis ? extractLinkCid(rootDecoded.parentBasis, 'parentBasis') : null;

  const expectedChildCids = new Set([resolvedRoot, registryCid, factsCid, quadsCid, joinsCid]);
  for (const needed of expectedChildCids) {
    if (!blocks.has(needed)) bad('closure-incomplete', needed);
  }
  // Ensure every block in the provided set is reachable from root (reject stray blocks).
  const reachable = new Set();
  const stack = [resolvedRoot];
  while (stack.length) {
    const cid = stack.pop();
    if (reachable.has(cid)) continue;
    reachable.add(cid);
    const bytes = blocks.get(cid);
    if (!bytes) {
      if (cid === parentBasisCid) continue;
      bad('closure-incomplete', cid);
    }
    for (const link of linksOf(cid, bytes)) {
      if (link === parentBasisCid && !blocks.has(link)) continue;
      stack.push(link);
    }
  }
  for (const cid of blocks.keys()) {
    if (!reachable.has(cid)) bad('block-not-reachable', cid);
  }

  // Validate sub-blocks
  const regDoc = fromDagCborSafe(decodeDagCbor(blocks.get(registryCid)).value);
  if (regDoc?.schema !== ONTOLOGY_REGISTRY_SCHEMA || regDoc.version !== 1) bad('invalid-registry-block', registryCid);
  const registry = createRegistry({
    objectTypes: regDoc.objectTypes ?? [],
    connectors: regDoc.connectors ?? [],
    includeDefaults: false,
  });

  const factsDoc = fromDagCborSafe(decodeDagCbor(blocks.get(factsCid)).value);
  if (factsDoc?.schema !== ONTOLOGY_FACTS_SCHEMA || factsDoc.version !== 1 || !Array.isArray(factsDoc.facts)) {
    bad('invalid-facts-block', factsCid);
  }
  if (factsDoc.facts.length > limits.maxFacts) bad('limit-exceeded', `maxFacts (${limits.maxFacts})`);
  for (let i = 0; i < factsDoc.facts.length; i++) {
    const f = factsDoc.facts[i];
    const source = normalizeKeyword(f?.['ontology/source']);
    if (!source || !taggedConforms(registry, source, f)) {
      bad('fact-provenance-invalid', `fact[${i}] fails connector provenance or conformance check`);
    }
  }

  const quadsDoc = fromDagCborSafe(decodeDagCbor(blocks.get(quadsCid)).value);
  if (quadsDoc?.schema !== ONTOLOGY_QUADS_SCHEMA || quadsDoc.version !== 1 || !Array.isArray(quadsDoc.quads)) {
    bad('invalid-quads-block', quadsCid);
  }
  if (quadsDoc.quads.length > limits.maxQuads) bad('limit-exceeded', `maxQuads (${limits.maxQuads})`);
  const quads = quadsDoc.quads.map(normalizeQuad);

  const joinsDoc = fromDagCborSafe(decodeDagCbor(blocks.get(joinsCid)).value);
  if (joinsDoc?.schema !== ONTOLOGY_JOINS_SCHEMA || joinsDoc.version !== 1 || !Array.isArray(joinsDoc.joinMappings)) {
    bad('invalid-joins-block', joinsCid);
  }
  const typeIds = new Set(registry.objectTypes.map((t) => t.id));
  const joinMappings = joinsDoc.joinMappings.map((j) => normalizeJoinMapping(j, typeIds));

  const blockList = [...blocks.entries()].map(([cid, bytes]) => ({ cid, bytes }));
  const carBytes = encodeCarV1([resolvedRoot], blockList);
  const snapshot = {
    schema: ONTOLOGY_SNAPSHOT_SCHEMA,
    version: 1,
    id: String(rootDecoded.id ?? 'default'),
    baseIri: String(rootDecoded.baseIri ?? DEFAULT_BASE_IRI),
    createdAt: rootDecoded.createdAt ?? null,
    parentBasisCid,
    basisCid: resolvedRoot,
    rootCid: resolvedRoot,
    blockCids: {
      root: resolvedRoot,
      registry: registryCid,
      facts: factsCid,
      quads: quadsCid,
      joins: joinsCid,
    },
    blocks,
    blockList,
    carBytes,
    registry,
    facts: factsDoc.facts,
    quads,
    joinMappings,
    stats: {
      objectTypes: registry.objectTypes.length,
      connectors: registry.connectors.length,
      facts: factsDoc.facts.length,
      quads: quads.length,
      joins: joinMappings.length,
    },
  };
  snapshot.tables = projectTables(snapshot);
  return snapshot;
}

/**
 * Visibility-gated quad scan (mirrors datalog.query/query).
 * `visible` predicate is REQUIRED (fail-closed: no permissive silent default).
 */
export function scanQuads(snapshot, pattern, visible, { maxScanned = 100_000, basisCid = null } = {}) {
  if (!snapshot || !Array.isArray(snapshot.quads)) bad('invalid-snapshot', 'snapshot.quads missing');
  if (basisCid && snapshot.basisCid !== basisCid) bad('basis-cid-mismatch', `expected ${basisCid}, got ${snapshot.basisCid}`);
  if (typeof visible !== 'function') {
    bad('visibility-predicate-required', 'scanQuads requires an explicit visible(quad) predicate');
  }
  const [ps, pp, po, pg] = Array.isArray(pattern) ? pattern : [null, null, null, null];
  const matchesTerm = (pat, val) => {
    if (pat === null || pat === undefined) return true;
    if (!val) return false;
    if (typeof pat === 'string') return val.value === pat;
    return rdfTermsEqual(pat, val);
  };
  const results = [];
  let scanned = 0;
  for (const q of snapshot.quads) {
    scanned += 1;
    if (scanned > maxScanned) bad('scan-limit-exceeded', `exceeded maxScanned=${maxScanned}`);
    if (!matchesTerm(ps, q.subject)) continue;
    if (!matchesTerm(pp, q.predicate)) continue;
    if (!matchesTerm(po, q.object)) continue;
    if (!matchesTerm(pg, q.graph)) continue;
    if (visible(q)) results.push(q);
  }
  return results;
}

/** Build a visibility predicate from declarative policy options (jurisdiction, allowedSources, custom visible). */
export function buildVisibilityFilter({ visible, jurisdiction, allowedSources } = {}) {
  const sourceSet = Array.isArray(allowedSources) && allowedSources.length > 0
    ? new Set(allowedSources.map((s) => normalizeKeyword(s) ?? String(s)))
    : null;
  const jurSet = jurisdiction
    ? new Set((Array.isArray(jurisdiction) ? jurisdiction : [jurisdiction]).map((j) => normalizeKeyword(j) ?? String(j)))
    : null;

  return (record) => {
    if (sourceSet) {
      const src = normalizeKeyword(record?.ontology_source ?? record?.['ontology/source']);
      if (src && !sourceSet.has(src)) return false;
    }
    if (jurSet) {
      const j = normalizeKeyword(record?.jurisdiction);
      if (j && !jurSet.has(j)) return false;
    }
    if (typeof visible === 'function' && !visible(record)) return false;
    return true;
  };
}

/** Extract all tag-42 link CID strings from an arbitrary canonical DAG-CBOR block. */
export function dagCborLinks(bytes) {
  const { value } = decodeDagCbor(bytes);
  return linksIn(value).map((b) => cidFromBytes(b)).filter(Boolean);
}
