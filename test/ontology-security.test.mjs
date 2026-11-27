import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildOntologySnapshot,
  verifyOntologySnapshot,
  ingestJsonLd,
  toDagCborSafe,
  OntologyError,
  DEFAULT_BASE_IRI,
} from '../src/ontology.mjs';
import { executeSql, SqlError } from '../src/ontology-sql.mjs';
import { executeSparql, ednToAlgebra, compileLinearRegex, SparqlError } from '../src/ontology-sparql.mjs';
import {
  buildOntologyGraph,
  encodeOntologyGraphDagCbor,
  verifyOntologyGraphCid,
  renderOntologySvg,
  renderOntologyHtml,
  safeJsonScript,
  createDefaultOntologySnapshot,
} from '../src/ontology-viz.mjs';
import { invokeOntologyOperation } from '../src/ontology-viewer.mjs';
import { main as cliMain } from '../src/cli.mjs';
import { callTool, TOOLS } from '../src/mcp.mjs';
import { handle as workerHandle } from '../worker/src/index.mjs';
import { rawCid, cidFor, cidToBytes, CODEC_DAG_CBOR } from '../src/cid.mjs';
import { encodeDagCbor } from '../src/dag-cbor.mjs';
import { TOKEN, ENV, NOW, fakeStore } from './worker-fixtures.mjs';

function securityFixtureSpec() {
  return {
    id: 'sec-fixture',
    objectTypes: [
      { id: 'agency', name: 'Agency', attributes: { name: 'string', jurisdiction: 'keyword' }, key: ['name'] },
    ],
    connectors: [
      { id: 'jp.agencies', name: 'Agencies', objectType: 'agency', status: 'implemented' },
    ],
    facts: [
      { id: 't-nat', connectorId: 'jp.kkj', status: 'open', title: 'National Tender', agency_id: 'a-nat', jurisdiction: 'jp-national', amount: 100 },
      { id: 't-cross', connectorId: 'jp.kkj', status: 'open', title: 'Cross-Jur Tender', agency_id: 'a-tok', jurisdiction: 'jp-national', amount: 200 },
      { id: 't-tok', connectorId: 'jp.geps', status: 'awarded', title: 'Tokyo Tender', agency_id: 'a-tok', jurisdiction: 'jp-tokyo', amount: 300 },
      { id: 'a-nat', connectorId: 'jp.agencies', name: 'National Agency', jurisdiction: 'jp-national' },
      { id: 'a-tok', connectorId: 'jp.agencies', name: 'Tokyo Agency', jurisdiction: 'jp-tokyo' },
    ],
    quads: [
      {
        subject: 'https://external.example/untagged/1',
        predicate: 'https://external.example/ns#secret',
        object: 'untagged-quad-value',
      },
    ],
    joinMappings: [
      { name: 'tender_with_agency', leftType: 'tender', rightType: 'agency', leftKey: 'agency_id', rightKey: 'id', kind: 'inner' },
    ],
  };
}

// --- H-1: Limit escalation DoS prevention ---

test('H-1: caller limits cannot exceed defaults/Worker caps or use invalid/unknown keys', async () => {
  const snap = buildOntologySnapshot(securityFixtureSpec());
  const s = fakeStore();
  const deps = { fetchImpl: s.fetchImpl, now: NOW };
  const env = { ...ENV, MAX_BLOCK_BYTES: '65536' };

  // Direct engine rejects raising limits above hard defaults or unknown keys
  assert.throws(
    () => executeSql(snap, 'SELECT id FROM tender', { limits: { maxScanRows: 100_000_000 } }),
    (e) => e instanceof SqlError && e.code === 'invalid-limit',
  );
  assert.throws(
    () => executeSql(snap, 'SELECT id FROM tender', { limits: { maxQueryBytes: 10_000_000 } }),
    (e) => e instanceof SqlError && e.code === 'invalid-limit-key',
  );
  assert.throws(
    () => executeSql(snap, 'SELECT id FROM tender', { limits: { maxScanRows: 0 } }),
    (e) => e instanceof SqlError && e.code === 'invalid-limit',
  );
  assert.throws(
    () => executeSparql(snap, 'SELECT ?s WHERE { ?s ?p ?o . }', { limits: { maxScanSteps: 999_999_999 } }),
    (e) => e instanceof SparqlError && e.code === 'invalid-limit',
  );
  assert.throws(
    () => executeSparql(snap, 'SELECT ?s WHERE { ?s ?p ?o . }', { limits: { maxQueryBytes: 999_999 } }),
    (e) => e instanceof SparqlError && e.code === 'invalid-limit-key',
  );

  // Worker POST /ontology/sql rejects exceeding WORKER_SQL_LIMITS (20,000) or non-integer/negative
  for (const badLimits of [
    { maxScanRows: 25_000 },
    { maxResultRows: 999 },
    { maxQueryBytes: 64 * 1024 },
    { maxScanRows: -1 },
    { maxScanRows: 1.5 },
  ]) {
    const res = await workerHandle(
      new Request('https://yataverse.com/ontology/sql', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'SELECT id FROM tender', limits: badLimits }),
      }),
      env,
      deps,
    );
    assert.equal(res.status, 400, `expected 400 for limits=${JSON.stringify(badLimits)}`);
  }

  // maxNodes validation in buildOntologyGraph and invokeOntologyOperation
  for (const badMax of [0, -5, 1.5, 501, Number.NaN, '10']) {
    assert.throws(
      () => buildOntologyGraph(snap, { maxNodes: badMax }),
      (e) => e instanceof OntologyError && e.code === 'invalid-limit',
    );
  }
  await assert.rejects(
    () => invokeOntologyOperation('ontology.graph', { maxNodes: 999 }, { snapshot: snap }),
    (e) => e.code === 'invalid-limit',
  );

  // CLI rejects NaN / non-positive / oversized --max-scan
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yv-sec-'));
  try {
    const carFile = path.join(tmpDir, 'snap.car');
    fs.writeFileSync(carFile, snap.carBytes);
    let err = '';
    const io = { stdout: { write: () => {} }, stderr: { write: (x) => { err += x; } } };
    assert.equal(await cliMain(['ontology', 'sql', carFile, '--query', 'SELECT id FROM tender', '--max-scan', 'NaN'], io), 1);
    assert.match(err, /positive integer/);
    err = '';
    assert.equal(await cliMain(['ontology', 'sql', carFile, '--query', 'SELECT id FROM tender', '--max-scan', '999999999'], io), 1);
    assert.match(err, /invalid-limit/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // MCP rejects exceeding hard limits
  const mcpOver = await callTool('yataverse_ontology_query_sql', {
    car_base64: Buffer.from(snap.carBytes).toString('base64'),
    query: 'SELECT id FROM tender',
    max_scan_rows: 999_999,
  });
  assert.equal(mcpOver.isError, true);
  assert.match(mcpOver.text, /invalid-limit/);
});

// --- H-2: Linear-time Thompson NFA REGEX (ReDoS immunity) ---

test('H-2: SPARQL REGEX resists backtracking ReDoS payloads, refuses backrefs/lookarounds, enforces input len & step budget', () => {
  const evilInput = 'a'.repeat(45) + '!';
  const pathological = ['(a|a)+$', '(a+){2,}', '((a)+)+$', '.*.*.*!$', '([a-z]+)+$'];
  for (const pat of pathological) {
    const t0 = Date.now();
    const re = compileLinearRegex(pat);
    const matched = re.test(evilInput);
    const elapsed = Date.now() - t0;
    assert.equal(typeof matched, 'boolean');
    assert.ok(elapsed < 200, `pattern ${pat} took too long (${elapsed}ms)`);
  }

  // Backreferences & lookarounds refused
  for (const forbidden of ['(a+)\\1+', '(?=(a+))\\1+', '(?!abc)def', '(?<=a)b']) {
    assert.throws(
      () => compileLinearRegex(forbidden),
      (e) => e instanceof SparqlError && e.code === 'sparql-regex-too-complex',
      `expected sparql-regex-too-complex for ${forbidden}`,
    );
  }

  // Input length > 4096 refused
  const simpleRe = compileLinearRegex('^a+$');
  assert.throws(
    () => simpleRe.test('a'.repeat(4097)),
    (e) => e instanceof SparqlError && e.code === 'sparql-regex-input-too-long',
  );

  // REGEX charges state.steps against maxScanSteps
  const snap = buildOntologySnapshot({
    facts: [
      { id: 't1', connectorId: 'jp.kkj', status: 'open', title: 'x'.repeat(2000) },
    ],
  });
  assert.throws(
    () => executeSparql(
      snap,
      `PREFIX onto: <${DEFAULT_BASE_IRI}> SELECT ?t WHERE { ?s onto:title ?t . FILTER(REGEX(?t, "x+")) }`,
      { maxScanSteps: 20 },
    ),
    (e) => e instanceof SparqlError && e.code === 'scan-limit-exceeded',
  );
});

// --- H-3: Fail-closed visibility across allowedSources:[], ontology_quads, join views, SPARQL ---

test('H-3: visibility filter is strictly fail-closed on empty lists, ontology_quads, materialized join views, and SPARQL untagged quads', () => {
  const snap = buildOntologySnapshot(securityFixtureSpec());

  // Empty allowedSources: [] MUST deny everything (never fail-open!)
  assert.equal(executeSql(snap, 'SELECT * FROM tender', { allowedSources: [] }).rowCount, 0);
  assert.equal(executeSql(snap, 'SELECT * FROM ontology_quads', { allowedSources: [] }).rowCount, 0);
  assert.equal(executeSql(snap, 'SELECT * FROM tender_with_agency', { allowedSources: [] }).rowCount, 0);
  assert.equal(executeSparql(snap, 'SELECT ?s ?p ?o WHERE { ?s ?p ?o . }', { allowedSources: [] }).rowCount, 0);

  // Empty jurisdiction: [] MUST deny everything
  assert.equal(executeSql(snap, 'SELECT * FROM tender', { jurisdiction: [] }).rowCount, 0);
  assert.equal(executeSparql(snap, 'SELECT ?s ?p ?o WHERE { ?s ?p ?o . }', { jurisdiction: [] }).rowCount, 0);

  // ontology_quads with jurisdiction='jp-national' must NOT leak Tokyo quads or untagged external quads
  const natQuads = executeSql(snap, 'SELECT subject, object FROM ontology_quads', { jurisdiction: 'jp-national' });
  assert.ok(natQuads.rowCount > 0);
  assert.ok(!natQuads.rows.some((r) => String(r.object).includes('Tokyo')), 'Tokyo quad leaked');
  assert.ok(!natQuads.rows.some((r) => String(r.subject).includes('external.example')), 'untagged quad leaked');

  // Materialized join view tender_with_agency checks BOTH left AND right constituent provenance/jurisdiction:
  // t-cross is jp-national joined with a-tok (jp-tokyo) -> MUST be excluded under jurisdiction='jp-national'!
  const natJoined = executeSql(snap, 'SELECT tender_id, agency_id FROM tender_with_agency', { jurisdiction: 'jp-national' });
  assert.deepEqual(natJoined.rows, [{ tender_id: 't-nat', agency_id: 'a-nat' }]);

  // allowedSources: ['jp.kkj'] must exclude tender_with_agency rows because right side is jp.agencies
  const kkjJoined = executeSql(snap, 'SELECT tender_id FROM tender_with_agency', { allowedSources: ['jp.kkj'] });
  assert.equal(kkjJoined.rowCount, 0);

  // SPARQL with jurisdiction='jp-national' must NOT return the untagged external quad
  const sparqlNat = executeSparql(
    snap,
    'SELECT ?s ?o WHERE { ?s <https://external.example/ns#secret> ?o . }',
    { jurisdiction: 'jp-national' },
  );
  assert.equal(sparqlNat.rowCount, 0);
});

// --- H-4: Cartesian join cap, verifyOntologySnapshot bounds, graph edge cap, Worker POST 256 KiB cap ---

test('H-4: bounds prevent Cartesian join explosion, verifyOntologySnapshot limit bypass, graph edge explosion, and oversized Worker POST', async () => {
  // Cartesian join cap in projectTables
  const leftFacts = Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, connectorId: 'jp.kkj', status: 'open', join_k: 'same' }));
  const rightFacts = Array.from({ length: 20 }, (_, i) => ({ id: `a${i}`, connectorId: 'jp.agencies', name: `A${i}`, jurisdiction: 'jp', join_k: 'same' }));
  assert.throws(
    () => buildOntologySnapshot({
      objectTypes: [{ id: 'agency', name: 'Agency', attributes: { name: 'string' }, key: ['name'] }],
      connectors: [{ id: 'jp.agencies', name: 'Ag', objectType: 'agency' }],
      facts: [...leftFacts, ...rightFacts],
      joinMappings: [{ name: 'big_join', leftType: 'tender', rightType: 'agency', leftKey: 'join_k', rightKey: 'join_k' }],
    }, { limits: { maxJoinedRows: 50 } }),
    (e) => e instanceof OntologyError && e.code === 'limit-exceeded',
  );

  // verifyOntologySnapshot enforces maxObjectTypes, maxConnectors, maxJoins
  const snap = buildOntologySnapshot(securityFixtureSpec());
  assert.throws(
    () => verifyOntologySnapshot(snap.carBytes, { limits: { maxObjectTypes: 1 } }),
    (e) => e instanceof OntologyError && e.code === 'limit-exceeded',
  );
  assert.throws(
    () => verifyOntologySnapshot(snap.carBytes, { limits: { maxConnectors: 1 } }),
    (e) => e instanceof OntologyError && e.code === 'limit-exceeded',
  );
  assert.throws(
    () => verifyOntologySnapshot(snap.carBytes, { limits: { maxJoins: 0 } }),
    (e) => e instanceof OntologyError && e.code === 'limit-exceeded',
  );

  // buildOntologyGraph caps edges cleanly
  const denseSnap = buildOntologySnapshot({
    objectTypes: [{ id: 'agency', name: 'Agency', attributes: { name: 'string' }, key: ['name'] }],
    connectors: [{ id: 'jp.agencies', name: 'Ag', objectType: 'agency' }],
    facts: [...leftFacts, ...rightFacts],
    joinMappings: [{ name: 'dense_join', leftType: 'tender', rightType: 'agency', leftKey: 'join_k', rightKey: 'join_k' }],
  });
  const boundedGraph = buildOntologyGraph(denseSnap, { maxNodes: 20, maxEdges: 15 });
  assert.ok(boundedGraph.edges.length <= 15);
  assert.equal(boundedGraph.edgesTruncated, true);

  // Worker POST body > 256 KiB returns 413
  const s = fakeStore();
  const res413 = await workerHandle(
    new Request('https://yataverse.com/ontology/sql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT * FROM tender WHERE title = \'' + 'x'.repeat(270 * 1024) + '\'' }),
    }),
    ENV,
    { fetchImpl: s.fetchImpl, now: NOW },
  );
  assert.equal(res413.status, 413);
});

// --- M-1: Infinite recursion / stack overflow & DagCborError -> HTTP 400 ---

test('M-1: circular @context, deep nesting, oversized JSON algebra, and corrupt DAG-CBOR return structured errors (never stack overflow or 502)', async () => {
  // Circular JSON-LD @context
  assert.throws(
    () => ingestJsonLd({ '@context': { a: 'b', b: 'a' }, '@id': 'https://example.org/x', a: 'val' }),
    (e) => e instanceof OntologyError && e.code === 'jsonld-context-cycle',
  );
  // Malformed JSON string in ingestJsonLd -> OntologyError
  assert.throws(
    () => ingestJsonLd('{not-json'),
    (e) => e instanceof OntologyError && e.code === 'invalid-jsonld',
  );
  // Deeply nested value in toDagCborSafe
  let deep = { leaf: 1 };
  for (let i = 0; i < 80; i++) deep = { nested: deep };
  assert.throws(
    () => toDagCborSafe(deep),
    (e) => e instanceof OntologyError && e.code === 'dag-cbor-too-deep',
  );

  const snap = buildOntologySnapshot(securityFixtureSpec());

  // Deeply nested SQL
  const deepSql = `SELECT id FROM tender WHERE ${'NOT '.repeat(70)} status = 'open'`;
  assert.throws(
    () => executeSql(snap, deepSql),
    (e) => e instanceof SqlError && e.code === 'sql-expression-too-deep',
  );

  // Deeply nested SPARQL FILTER
  const deepSparql = `SELECT ?s WHERE { ?s ?p ?o . FILTER(${'('.repeat(70)}?o = "x"${')'.repeat(70)}) }`;
  assert.throws(
    () => executeSparql(snap, deepSparql),
    (e) => e instanceof SparqlError && e.code === 'sparql-too-deep',
  );

  // Oversized JSON algebra
  const hugePatterns = Array.from({ length: 400 }, (_, i) => [`?s${i}`, { rdfType: 'iri', value: `https://example.org/p${i}` }, `?o${i}`]);
  assert.throws(
    () => executeSparql(snap, { op: 'bgp', patterns: hugePatterns }),
    (e) => e instanceof SparqlError && e.code === 'sparql-query-too-large',
  );

  // Invalid JSON algebra shape
  assert.throws(
    () => executeSparql(snap, { op: 'bgp', patterns: 'not-an-array' }),
    (e) => e instanceof SparqlError && e.code === 'invalid-algebra',
  );

  // Worker maps non-canonical DAG-CBOR block error to 400 (never 502)
  const s = fakeStore();
  const badCbor = Buffer.from('a2616201616102', 'hex'); // unsorted keys
  const badCid = cidFor(badCbor, CODEC_DAG_CBOR);
  s.objects.set(`ipld/${badCid}`, badCbor);
  const res = await workerHandle(
    new Request(`https://yataverse.com/ontology/v1/inspect/${badCid}`),
    ENV,
    { fetchImpl: s.fetchImpl, now: NOW },
  );
  assert.equal(res.status, 400);
});

// --- M-2: READ_DENY_CIDS fail-closed 503, stateless CAR/build deny check, cid/basisCid conflict ---

test('M-2: malformed READ_DENY_CIDS fails closed 503 everywhere; stateless carBase64/build check readDenied; cid/basisCid conflict is 400', async () => {
  const s = fakeStore();
  const deps = { fetchImpl: s.fetchImpl, now: NOW };
  const badDenyEnv = { ...ENV, READ_DENY_CIDS: 'not-a-valid-cid' };

  for (const req of [
    new Request('https://yataverse.com/'),
    new Request('https://yataverse.com/ontology'),
    new Request('https://yataverse.com/ontology/graph'),
    new Request('https://yataverse.com/ontology/v1/schema'),
    new Request('https://yataverse.com/ontology/sql', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'SELECT id FROM tender' }),
    }),
    new Request('https://yataverse.com/ontology/sparql', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'SELECT ?s WHERE { ?s ?p ?o . }' }),
    }),
  ]) {
    const res = await workerHandle(req, badDenyEnv, deps);
    assert.equal(res.status, 503, `expected 503 on ${req.url}`);
    assert.equal((await res.json()).error, 'read-deny-list-invalid');
  }

  // Stateless carBase64 containing a denied child block CID returns 451
  const snap = buildOntologySnapshot(securityFixtureSpec());
  const denyChildEnv = { ...ENV, READ_DENY_CIDS: snap.blockCids.facts };
  const carB64 = Buffer.from(snap.carBytes).toString('base64');
  const statelessRes = await workerHandle(
    new Request('https://yataverse.com/ontology/v1/ops/ontology.inspect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ carBase64: carB64 }),
    }),
    denyChildEnv,
    deps,
  );
  assert.equal(statelessRes.status, 451);

  // ontology.build with a denied pinnedContext CID returns 451
  const ctxObj = { ex: 'https://example.org/ns#' };
  const ctxCid = cidFor(encodeDagCbor(ctxObj), CODEC_DAG_CBOR);
  const buildDenied = await workerHandle(
    new Request('https://yataverse.com/ontology/v1/ops/ontology.build', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pinnedContexts: { 'https://example.org/ctx': { cid: ctxCid, context: ctxObj } },
      }),
    }),
    { ...ENV, READ_DENY_CIDS: ctxCid },
    deps,
  );
  assert.equal(buildDenied.status, 451);

  // Conflicting cid vs basisCid on POST /ontology/sql and POST /ontology/sparql -> 400
  const otherCid = cidFor(encodeDagCbor({ other: 1 }), CODEC_DAG_CBOR);
  for (const endpoint of ['/ontology/sql', '/ontology/sparql']) {
    const res = await workerHandle(
      new Request(`https://yataverse.com${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          cid: snap.basisCid,
          basisCid: otherCid,
          query: endpoint.endsWith('sql') ? 'SELECT id FROM tender' : 'SELECT ?s WHERE { ?s ?p ?o . }',
        }),
      }),
      ENV,
      deps,
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'conflicting-cid-parameters');
  }
});

// --- M-3: Prototype pollution / Object.prototype collision prevention ---

test('M-3: __proto__, constructor, prototype keys are refused without polluting Object.prototype', () => {
  const snap = buildOntologySnapshot(securityFixtureSpec());

  // Fact key __proto__ (via JSON.parse to create own property named __proto__)
  const evilFact = JSON.parse('{"id":"x","connectorId":"jp.kkj","status":"open","__proto__":{"polluted":true}}');
  assert.throws(
    () => buildOntologySnapshot({ facts: [evilFact] }),
    (e) => e instanceof OntologyError && e.code === 'forbidden-key',
  );

  // SQL alias __proto__ / constructor refused
  assert.throws(
    () => executeSql(snap, 'SELECT id AS "__proto__" FROM tender'),
    (e) => e instanceof SqlError && e.code === 'sql-forbidden-identifier',
  );
  assert.throws(
    () => executeSql(snap, 'SELECT id AS constructor FROM tender'),
    (e) => e instanceof SqlError && e.code === 'sql-forbidden-identifier',
  );

  // SPARQL prefix constructor: refused
  assert.throws(
    () => executeSparql(snap, 'PREFIX constructor: <https://example.org/> SELECT ?s WHERE { ?s constructor:a ?o . }'),
    (e) => e instanceof SparqlError && e.code === 'sparql-forbidden-prefix',
  );

  // EDN map with __proto__ refused
  assert.throws(
    () => executeSparql(snap, { edn: '{:sparql/op :bgp "__proto__" 1 :patterns []}' }),
    (e) => e instanceof SparqlError && e.code === 'edn-forbidden-key',
  );

  assert.equal(({}).polluted, undefined);
});

// --- L-1, L-2, L-3: Codec check on links, strict CSP & endpoint validation, CLI/MCP hardening ---

test('L-1/L-2/L-3: child link codec enforcement, strict CSP without unsafe-inline scripts, safeJsonScript, endpoint validation, CLI usage & MCP caps', async () => {
  // L-1: Root linking a raw CID as `facts` must be refused
  const rawLeaf = Buffer.from('not-dag-cbor');
  const rawLeafCid = rawCid(rawLeaf);
  const regBytes = encodeDagCbor({ schema: 'yataverse.ontology.registry/v1', version: 1, objectTypes: [], connectors: [] });
  const regCid = cidFor(regBytes, CODEC_DAG_CBOR);
  const qBytes = encodeDagCbor({ schema: 'yataverse.ontology.quads/v1', version: 1, quads: [] });
  const qCid = cidFor(qBytes, CODEC_DAG_CBOR);
  const jBytes = encodeDagCbor({ schema: 'yataverse.ontology.joins/v1', version: 1, joinMappings: [] });
  const jCid = cidFor(jBytes, CODEC_DAG_CBOR);
  const badRootBytes = encodeDagCbor({
    schema: 'yataverse.ontology.snapshot/v1',
    version: 1,
    id: 'bad-link-codec',
    baseIri: DEFAULT_BASE_IRI,
    registry: { cid: cidToBytes(regCid) },
    facts: { cid: cidToBytes(rawLeafCid) },
    quads: { cid: cidToBytes(qCid) },
    joins: { cid: cidToBytes(jCid) },
    stats: { objectTypes: 0, connectors: 0, facts: 0, quads: 0, joins: 0 },
  });
  const badRootCid = cidFor(badRootBytes, CODEC_DAG_CBOR);
  const badMap = new Map([
    [badRootCid, badRootBytes],
    [regCid, regBytes],
    [rawLeafCid, rawLeaf],
    [qCid, qBytes],
    [jCid, jBytes],
  ]);
  assert.throws(
    () => verifyOntologySnapshot(badMap, { rootCid: badRootCid }),
    (e) => e instanceof OntologyError && e.code === 'invalid-cid-link-codec',
  );

  // L-1: Snapshot with external parentBasis loads in Worker without requiring parentBasis block to be stored
  const parentCid = cidFor(encodeDagCbor({ schema: 'yataverse.ontology.snapshot/v1', version: 1, id: 'parent' }), CODEC_DAG_CBOR);
  const childSnap = buildOntologySnapshot({ ...securityFixtureSpec(), basisCid: parentCid });
  const s = fakeStore();
  const deps = { fetchImpl: s.fetchImpl, now: NOW };
  const env = { ...ENV, MAX_BLOCK_BYTES: '65536' };
  for (const [cid, bytes] of childSnap.blocks.entries()) s.objects.set(`ipld/${cid}`, Buffer.from(bytes));
  const okChild = await workerHandle(new Request(`https://yataverse.com/ontology/v1/inspect/${childSnap.basisCid}`), env, deps);
  assert.equal(okChild.status, 200);
  // And denying parentBasis still blocks reading the child snapshot
  const deniedParent = await workerHandle(
    new Request(`https://yataverse.com/ontology/v1/inspect/${childSnap.basisCid}`),
    { ...env, READ_DENY_CIDS: parentCid },
    deps,
  );
  assert.equal(deniedParent.status, 451);

  // L-2: Strict CSP on GET / (script-src 'none') and Viewer (script-src 'sha256-...', no unsafe-inline!)
  const homeRes = await workerHandle(new Request('https://yataverse.com/'), env, deps);
  const homeCsp = homeRes.headers.get('content-security-policy');
  assert.match(homeCsp, /script-src 'none'/);
  assert.match(homeCsp, /base-uri 'none'/);
  assert.match(homeCsp, /form-action 'self'/);
  assert.match(homeCsp, /frame-ancestors 'none'/);

  const viewerRes = await workerHandle(new Request('https://yataverse.com/ontology/viewer'), env, deps);
  const viewerCsp = viewerRes.headers.get('content-security-policy');
  assert.match(viewerCsp, /script-src 'sha256-[A-Za-z0-9+/=]+'/);
  assert.ok(!/script-src[^;]*'unsafe-inline'/.test(viewerCsp), 'Viewer script-src must not allow unsafe-inline');
  assert.match(viewerCsp, /base-uri 'none'/);
  assert.match(viewerCsp, /frame-ancestors 'none'/);

  // L-2: safeJsonScript escapes \u2028, \u2029, &, <, >
  const escaped = safeJsonScript({ s: '<script>&\u2028\u2029>' });
  assert.ok(!escaped.includes('<') && !escaped.includes('>') && !escaped.includes('&'));
  assert.ok(!escaped.includes('\u2028') && !escaped.includes('\u2029'));

  // L-2: invalid endpoint path refused
  assert.throws(
    () => renderOntologyHtml(childSnap, { apiBase: 'https://evil.example/api' }),
    (e) => e instanceof OntologyError && e.code === 'invalid-endpoint-path',
  );
  assert.throws(
    () => renderOntologyHtml(childSnap, { viewerPath: 'javascript:alert(1)' }),
    (e) => e instanceof OntologyError && e.code === 'invalid-endpoint-path',
  );

  // L-3: CLI usage includes `graph`; MCP enforces input size caps & documents network fetch
  let err = '';
  const io = { stdout: { write: () => {} }, stderr: { write: (x) => { err += x; } } };
  assert.equal(await cliMain(['ontology', 'unknown-sub'], io), 2);
  assert.match(err, /\|graph\|/);

  const bigSpec = await callTool('yataverse_ontology_build', { spec: 'x'.repeat(1024 * 1024 + 10) });
  assert.equal(bigSpec.isError, true);
  assert.match(bigSpec.text, /spec-too-large/);

  const bigCar = await callTool('yataverse_ontology_verify', { car_base64: 'A'.repeat(1_400_000) });
  assert.equal(bigCar.isError, true);
  assert.match(bigCar.text, /car-too-large/);

  for (const toolName of [
    'yataverse_ontology_inspect',
    'yataverse_ontology_graph',
    'yataverse_ontology_query_sql',
    'yataverse_ontology_query_sparql',
    'yataverse_ontology_view',
  ]) {
    const tool = TOOLS.find((t) => t.name === toolName);
    assert.match(tool.description, /network/i, `${toolName} should mention network gateway fetch`);
  }
});

// --- N-1, N-2, N-3 & G2 activeLayers:[] Consistency ---

test('N-1/N-2/N-3: malformed-type EDN/build return 400 (never 502), POST ontology.graph checks derived graphCid 451, REGEX s flag works, CSP SHA-256 matches inline script', async () => {
  const s = fakeStore();
  const deps = { fetchImpl: s.fetchImpl, now: NOW };
  const env = { ...ENV, MAX_BLOCK_BYTES: '65536' };

  // N-1: malformed-type ontology.build inputs -> 400 (never TypeError -> 502)
  for (const badBody of [
    { objectTypes: 123 },
    { connectors: { bad: true } },
    { facts: 'not-an-array' },
    { quads: 42 },
    { joinMappings: 'nope' },
    { pinnedContexts: 99 },
    { objectTypes: [{ id: 'custom', key: 'not-array' }] },
  ]) {
    const res = await workerHandle(
      new Request('https://yataverse.com/ontology/v1/ops/ontology.build', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(badBody),
      }),
      env,
      deps,
    );
    assert.equal(res.status, 400, `expected 400 for build body ${JSON.stringify(badBody)}`);
  }

  // N-1: malformed-type EDN inputs -> 400 (never TypeError -> 502)
  for (const badEdn of [
    '{:sparql/op :bgp :patterns 123}',
    '{:sparql/op :bgp :patterns [123]}',
    '{:sparql/op :project :vars 999 :pattern {:sparql/op :bgp :patterns []}}',
    '{:sparql/op :group :by [] :aggregates [123] :pattern {:sparql/op :bgp :patterns []}}',
    '{:sparql/op :filter :expr [:and ?x] :pattern {:sparql/op :bgp :patterns []}}',
  ]) {
    const res = await workerHandle(
      new Request('https://yataverse.com/ontology/sparql', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ algebraEdn: badEdn }),
      }),
      env,
      deps,
    );
    assert.equal(res.status, 400, `expected 400 for EDN ${badEdn}`);
  }

  // N-2: POST /ontology/v1/ops/ontology.graph enforces READ_DENY_CIDS on derived graphCid alone -> 451
  const snap = buildOntologySnapshot(securityFixtureSpec());
  const { cid: derivedGraphCid } = encodeOntologyGraphDagCbor(buildOntologyGraph(snap));
  const deniedGraphOp = await workerHandle(
    new Request('https://yataverse.com/ontology/v1/ops/ontology.graph', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ carBase64: Buffer.from(snap.carBytes).toString('base64') }),
    }),
    { ...env, READ_DENY_CIDS: derivedGraphCid },
    deps,
  );
  assert.equal(deniedGraphOp.status, 451);

  // N-3: compileLinearRegex dotAll 's' flag
  assert.equal(compileLinearRegex('a.b').test('a\nb'), false);
  assert.equal(compileLinearRegex('a.b', 's').test('a\nb'), true);
  assert.equal(compileLinearRegex('a.b', 'is').test('A\nB'), true);

  const nlSnap = buildOntologySnapshot({
    facts: [{ id: 'nl1', connectorId: 'jp.kkj', status: 'open', title: 'line1\nline2' }],
  });
  const noS = executeSparql(
    nlSnap,
    `PREFIX onto: <${DEFAULT_BASE_IRI}> SELECT ?t WHERE { ?s onto:title ?t . FILTER(REGEX(?t, "line1.line2")) }`,
  );
  assert.equal(noS.rowCount, 0);
  const withS = executeSparql(
    nlSnap,
    `PREFIX onto: <${DEFAULT_BASE_IRI}> SELECT ?t WHERE { ?s onto:title ?t . FILTER(REGEX(?t, "line1.line2", "s")) }`,
  );
  assert.equal(withS.rowCount, 1);

  // Verify VIEWER_CSP script-src sha256 matches the actual <script> tag body in GET /ontology/viewer HTML
  const viewerRes = await workerHandle(new Request('https://yataverse.com/ontology/viewer'), env, deps);
  assert.equal(viewerRes.status, 200);
  const csp = viewerRes.headers.get('content-security-policy');
  const html = await viewerRes.text();
  const scriptMatch = /<script>([\s\S]*?)<\/script>\s*<\/body>/.exec(html);
  assert.ok(scriptMatch, 'viewer HTML missing inline <script>');
  const actualSha = crypto.createHash('sha256').update(scriptMatch[1], 'utf8').digest('base64');
  assert.ok(csp.includes(`'sha256-${actualSha}'`), `CSP ${csp} did not match script sha256 ${actualSha}`);
});

test('G2 activeLayers: [] yields 0 nodes / 0 edges consistently across buildOntologyGraph, ontology.graph, ontology.view, and Worker routes', async () => {
  const seeded = createDefaultOntologySnapshot();
  const allGraph = buildOntologyGraph(seeded);
  const nullGraph = buildOntologyGraph(seeded, { activeLayers: null });
  assert.equal(allGraph.nodeCount, 9);
  assert.equal(nullGraph.nodeCount, 9);

  // Empty array activeLayers: [] -> 0 nodes, 0 edges (distinct from undefined/null!)
  const emptyGraph = buildOntologyGraph(seeded, { activeLayers: [] });
  assert.equal(emptyGraph.nodeCount, 0);
  assert.equal(emptyGraph.nodes.length, 0);
  assert.equal(emptyGraph.edges.length, 0);
  assert.equal(emptyGraph.meta.nodeCount, 0);
  assert.equal(emptyGraph.meta.edgeCount, 0);

  // Agent/API operations: ontology.graph & ontology.view with activeLayers: []
  const opGraph = await invokeOntologyOperation('ontology.graph', { activeLayers: [] }, { snapshot: seeded });
  assert.equal(opGraph.result.nodeCount, 0);
  assert.equal(opGraph.result.nodes.length, 0);
  assert.equal(opGraph.result.edges.length, 0);

  const opView = await invokeOntologyOperation('ontology.view', { activeLayers: [], format: 'all' }, { snapshot: seeded });
  assert.equal(opView.result.viewModel.graph.nodeCount, 0);
  assert.equal(opView.result.viewModel.graph.edges.length, 0);
  assert.ok(!opView.result.svg.includes('class="yv-node"'));
  const stMatch = /id="yataverse-screen-state">([\s\S]*?)<\/script>/.exec(opView.result.html);
  assert.ok(stMatch);
  const st = JSON.parse(stMatch[1]);
  assert.deepEqual(st.activeLayers, []);
  assert.equal(st.visibleNodeCount, 0);
  assert.equal(st.visibleEdgeCount, 0);
  assert.equal(st.selectedNodeId, null);

  // Worker GET /ontology/graph?activeLayers= & GET /ontology/viewer?activeLayers= match
  const s = fakeStore();
  const deps = { fetchImpl: s.fetchImpl, now: NOW };
  const wGraph = await workerHandle(new Request('https://yataverse.com/ontology/graph?activeLayers='), ENV, deps);
  assert.equal(wGraph.status, 200);
  const wGraphJson = await wGraph.json();
  assert.equal(wGraphJson.result.nodeCount, 0);
  assert.equal(wGraphJson.result.edges.length, 0);

  const wViewer = await workerHandle(new Request('https://yataverse.com/ontology/viewer?activeLayers='), ENV, deps);
  assert.equal(wViewer.status, 200);
  const wHtml = await wViewer.text();
  assert.match(wHtml, /data-active-layers=""/);
  assert.ok(!wHtml.includes('class="yv-node"'));
});

test('R3-1/R3-2/R3-3: __proto__ graphCid bypass refused, null-prototype EDN maps return 400/SparqlError, and SVG layer maps are null-prototype', async () => {
  // R3-1: JSON.parse('{"__proto__":...}') carrying valid graphCid must NOT silently drop __proto__
  const seeded = createDefaultOntologySnapshot();
  const baseGraph = buildOntologyGraph(seeded);
  const { cid: validGraphCid } = encodeOntologyGraphDagCbor(baseGraph);
  const wireJson = JSON.stringify({ ...baseGraph, graphCid: validGraphCid });
  const poisonedWire = JSON.parse(wireJson.replace(/^\{/, '{"__proto__":{"polluted":true},'));
  assert.equal(Object.hasOwn(poisonedWire, '__proto__'), true);
  assert.throws(
    () => verifyOntologyGraphCid(poisonedWire),
    (e) => e instanceof OntologyError && e.code === 'forbidden-key',
  );
  assert.throws(
    () => renderOntologySvg(poisonedWire),
    (e) => e instanceof OntologyError && e.code === 'forbidden-key',
  );
  assert.throws(
    () => encodeOntologyGraphDagCbor(poisonedWire),
    (e) => e instanceof OntologyError && e.code === 'forbidden-key',
  );
  assert.equal(({}).polluted, undefined);

  // R3-2: null-prototype EDN maps in map key, :rdf/type, :vars, :desc, :by, :arg, :var -> SparqlError & HTTP 400 (never TypeError -> 502)
  const s = fakeStore();
  const deps = { fetchImpl: s.fetchImpl, now: NOW };
  const r3EdnCases = [
    { name: 'non-string map key', edn: '{{:a 1} 2}', code: 'edn-invalid-key' },
    { name: ':rdf/type nested map', edn: '{:sparql/op :bgp :patterns [[?s ?p {:rdf/type {:a 1} :value "x"}]]}', code: 'edn-invalid-term' },
    { name: 'project :vars nested map', edn: '{:sparql/op :project :vars [{:a 1}] :pattern {:sparql/op :bgp :patterns []}}', code: 'edn-invalid-algebra' },
    { name: 'order-by :desc nested map', edn: '{:sparql/op :order-by :vars [?x] :desc #{{:a 1}} :pattern {:sparql/op :bgp :patterns []}}', code: 'edn-invalid-algebra' },
    { name: 'order-by :vars nested map', edn: '{:sparql/op :order-by :vars [{:a 1}] :pattern {:sparql/op :bgp :patterns []}}', code: 'edn-invalid-algebra' },
    { name: 'group :by nested map', edn: '{:sparql/op :group :by [{:a 1}] :aggregates [] :pattern {:sparql/op :bgp :patterns []}}', code: 'edn-invalid-algebra' },
    { name: 'group :arg nested map', edn: '{:sparql/op :group :by [] :aggregates [{:fn :count :arg {:a 1} :var ?c}] :pattern {:sparql/op :bgp :patterns []}}', code: 'edn-invalid-algebra' },
    { name: 'group :var nested map', edn: '{:sparql/op :group :by [] :aggregates [{:fn :count :arg :* :var {:a 1}}] :pattern {:sparql/op :bgp :patterns []}}', code: 'edn-invalid-algebra' },
  ];
  for (const tc of r3EdnCases) {
    assert.throws(
      () => ednToAlgebra(tc.edn),
      (e) => e instanceof SparqlError && e.code === tc.code,
      `expected SparqlError(${tc.code}) for ${tc.name}`,
    );
    const res = await workerHandle(
      new Request('https://yataverse.com/ontology/sparql', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ algebraEdn: tc.edn }),
      }),
      ENV,
      deps,
    );
    assert.equal(res.status, 400, `expected HTTP 400 for ${tc.name}: ${tc.edn}`);
  }

  // R3-3: renderOntologySvg cols/rowsByLayer/palette do not inherit Object.prototype properties
  const protoLayerGraph = {
    ...baseGraph,
    layers: [...baseGraph.layers, { id: 'toString', label: 'toString', nodeCount: 1 }],
    nodes: [
      ...baseGraph.nodes,
      { id: 'custom:1', layer: 'toString', label: 'Custom Node', objectType: null, connectorId: null, jurisdiction: null, meta: {} },
    ],
  };
  const svg = renderOntologySvg(protoLayerGraph);
  assert.match(svg, /^<svg /);
  assert.ok(!svg.includes('NaN'), 'SVG layout must not produce NaN for prototype-named layer');
  assert.ok(!svg.includes('[object Object]'), 'SVG styles must not leak Object.prototype properties');
});
