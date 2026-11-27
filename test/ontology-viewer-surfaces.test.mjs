import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildOntologySnapshot, DEFAULT_BASE_IRI } from '../src/ontology.mjs';
import {
  ONTOLOGY_OPERATIONS,
  NOUN_VERB_PATTERN,
  getOntologySchema,
  invokeOntologyOperation,
  renderOntologyViewer,
} from '../src/ontology-viewer.mjs';
import { main as cliMain } from '../src/cli.mjs';
import { callTool, TOOLS } from '../src/mcp.mjs';
import { handle as workerHandle } from '../worker/src/index.mjs';
import { TOKEN, ENV, NOW, fakeStore } from './worker-fixtures.mjs';

const FORBIDDEN_TOKENS = /jp-go-dds|jp_go_dds|dds\.lock|dds\.css|dads-|kotobase\.net|gftd|mithril/i;

function demoSpec() {
  return {
    id: 'viewer-demo',
    objectTypes: [
      { id: 'agency', name: 'Agency', attributes: { name: 'string' }, key: ['name'] },
    ],
    connectors: [
      { id: 'jp.agencies', name: 'Agencies', objectType: 'agency', status: 'implemented' },
    ],
    facts: [
      {
        id: 't-1',
        connectorId: 'jp.kkj',
        status: 'open',
        title: 'Safe <script>alert("xss")</script> Tender',
        agency_id: 'a-1',
        jurisdiction: 'jp-national',
        amount: 500,
      },
      {
        id: 'a-1',
        connectorId: 'jp.agencies',
        name: 'Digital Agency',
        jurisdiction: 'jp-national',
      },
    ],
    joinMappings: [
      { name: 'tender_agency', leftType: 'tender', rightType: 'agency', leftKey: 'agency_id', rightKey: 'id' },
    ],
  };
}

const captureIo = () => {
  let out = '';
  let err = '';
  return {
    stdout: { write: (x) => { out += typeof x === 'string' ? x : Buffer.from(x).toString('utf8'); } },
    stderr: { write: (x) => { err += typeof x === 'string' ? x : Buffer.from(x).toString('utf8'); } },
    get out() { return out; },
    get err() { return err; },
  };
};

test('Semantic UI contract: noun.verb operations, schemas, XSS-safe viewer, and zero forbidden DADS/GFTD tokens', async () => {
  const schema = getOntologySchema();
  assert.equal(schema.protocol, 'noun.verb');
  assert.equal(schema.readOnly, true);
  assert.ok(ONTOLOGY_OPERATIONS.length >= 6);
  for (const op of ONTOLOGY_OPERATIONS) {
    assert.match(op.operation, NOUN_VERB_PATTERN, `bad operation name: ${op.operation}`);
    assert.equal(op.operation, `${op.noun}.${op.verb}`);
    assert.equal(op.readOnly, true);
    assert.equal(op.inputSchema.type, 'object');
    assert.equal(op.outputSchema.type, 'object');
  }

  const snap = buildOntologySnapshot(demoSpec());
  const viewer = renderOntologyViewer(snap, { format: 'all' });

  // Viewer contains semantic HTML landmarks, inline schema, data-operation hooks, and escapes XSS
  assert.match(viewer.html, /data-operation="ontology\.query_sql"/);
  assert.match(viewer.html, /data-operation="ontology\.query_sparql"/);
  assert.match(viewer.html, /id="yataverse-semantic-schema"/);
  assert.ok(!viewer.html.includes('<script>alert("xss")</script>'), 'raw script tag must be escaped');
  assert.ok(!viewer.svg.includes('<script>alert("xss")</script>'), 'SVG must escape untrusted text');

  // Strict anti-DADS / anti-GFTD / anti-kotobase.net verification across viewer outputs & source modules
  assert.ok(!FORBIDDEN_TOKENS.test(viewer.html), 'viewer HTML contained a forbidden token');
  assert.ok(!FORBIDDEN_TOKENS.test(viewer.svg), 'viewer SVG contained a forbidden token');
  assert.ok(!FORBIDDEN_TOKENS.test(JSON.stringify(schema)), 'schema contained a forbidden token');

  for (const rel of [
    'src/ontology.mjs',
    'src/ontology-sql.mjs',
    'src/ontology-sparql.mjs',
    'src/ontology-viewer.mjs',
    'worker/src/ontology.mjs',
    'docs/ontology-sql-sparql-viewer.md',
  ]) {
    const src = fs.readFileSync(path.resolve(rel), 'utf8');
    assert.ok(!FORBIDDEN_TOKENS.test(src), `${rel} contained a forbidden token`);
  }

  // Unknown operation or unknown input field fails closed
  await assert.rejects(
    () => invokeOntologyOperation('ontology.drop_all', {}, { snapshot: snap }),
    (e) => e.code === 'unknown-operation',
  );
  await assert.rejects(
    () => invokeOntologyOperation('ontology.inspect', { unknownField: 1 }, { snapshot: snap }),
    (e) => e.code === 'unknown-input-field',
  );
});

test('CLI: ontology schema, build, verify, inspect, sql, sparql, view end-to-end', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yv-onto-'));
  try {
    const specFile = path.join(tmpDir, 'spec.json');
    const carFile = path.join(tmpDir, 'snap.car');
    const htmlFile = path.join(tmpDir, 'viewer.html');
    fs.writeFileSync(specFile, JSON.stringify(demoSpec()));

    let io = captureIo();
    assert.equal(await cliMain(['ontology', 'schema'], io), 0);
    assert.equal(JSON.parse(io.out).protocol, 'noun.verb');

    io = captureIo();
    assert.equal(await cliMain(['ontology', 'build', specFile, '-o', carFile], io), 0);
    const built = JSON.parse(io.out);
    assert.match(built.basisCid, /^bafyrei/);
    assert.ok(fs.existsSync(carFile));

    io = captureIo();
    assert.equal(await cliMain(['ontology', 'verify', carFile, '--basis', built.basisCid], io), 0);
    assert.equal(JSON.parse(io.out).result.verified, true);

    io = captureIo();
    assert.equal(await cliMain(['ontology', 'inspect', carFile], io), 0);
    assert.equal(JSON.parse(io.out).result.stats.facts, 2);

    io = captureIo();
    assert.equal(
      await cliMain(['ontology', 'sql', carFile, '--query', 'SELECT id, amount FROM tender WHERE status = \'open\''], io),
      0,
    );
    assert.deepEqual(JSON.parse(io.out).result.rows, [{ id: 't-1', amount: 500 }]);

    io = captureIo();
    assert.equal(
      await cliMain([
        'ontology', 'sparql', carFile,
        '--query', `PREFIX onto: <${DEFAULT_BASE_IRI}> SELECT ?a WHERE { ?s onto:amount ?a . }`,
      ], io),
      0,
    );
    assert.deepEqual(JSON.parse(io.out).result.rows, [{ '?a': 500 }]);

    io = captureIo();
    assert.equal(await cliMain(['ontology', 'view', carFile, '--format', 'html', '-o', htmlFile], io), 0);
    assert.match(fs.readFileSync(htmlFile, 'utf8'), /<!doctype html>/i);

    // Negative CLI: write SQL refused with exit code 1
    io = captureIo();
    assert.equal(await cliMain(['ontology', 'sql', carFile, '--query', 'DELETE FROM tender'], io), 1);
    assert.match(io.err, /sql-write-refused/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('MCP: yataverse_ontology_* tools round-trip & credential-like argument refusal', async () => {
  assert.ok(TOOLS.some((t) => t.name === 'yataverse_ontology_schema'));
  assert.ok(TOOLS.some((t) => t.name === 'yataverse_ontology_query_sql'));
  assert.ok(TOOLS.some((t) => t.name === 'yataverse_ontology_query_sparql'));
  assert.ok(TOOLS.some((t) => t.name === 'yataverse_ontology_view'));

  const schemaRes = await callTool('yataverse_ontology_schema', {});
  assert.equal(schemaRes.isError, false);
  assert.equal(JSON.parse(schemaRes.text).protocol, 'noun.verb');

  const builtRes = await callTool('yataverse_ontology_build', { spec: JSON.stringify(demoSpec()) });
  assert.equal(builtRes.isError, false);
  const built = JSON.parse(builtRes.text);
  const carBase64 = built.result.carBase64;
  const basisCid = built.basisCid;

  const inspectRes = await callTool('yataverse_ontology_inspect', { car_base64: carBase64, basis_cid: basisCid });
  assert.equal(inspectRes.isError, false);
  assert.equal(JSON.parse(inspectRes.text).result.id, 'viewer-demo');

  const sqlRes = await callTool('yataverse_ontology_query_sql', {
    car_base64: carBase64,
    basis_cid: basisCid,
    query: 'SELECT COUNT(*) AS n FROM tender',
  });
  assert.equal(sqlRes.isError, false);
  assert.deepEqual(JSON.parse(sqlRes.text).result.rows, [{ n: 1 }]);

  const sparqlRes = await callTool('yataverse_ontology_query_sparql', {
    car_base64: carBase64,
    basis_cid: basisCid,
    query: `PREFIX onto: <${DEFAULT_BASE_IRI}> ASK WHERE { ?s onto:status "open" . }`,
  });
  assert.equal(sparqlRes.isError, false);
  assert.equal(JSON.parse(sparqlRes.text).result.boolean, true);

  const viewRes = await callTool('yataverse_ontology_view', {
    car_base64: carBase64,
    basis_cid: basisCid,
    format: 'svg',
  });
  assert.equal(viewRes.isError, false);
  assert.match(JSON.parse(viewRes.text).result.svg, /^<svg /);

  // Negative: credential-like arg refused
  const badArg = await callTool('yataverse_ontology_query_sql', { query: 'SELECT 1 FROM tender', token: 'secret' });
  assert.equal(badArg.isError, true);
  assert.match(badArg.text, /credentials never travel/);

  // Negative: remote SERVICE refused
  const badSparql = await callTool('yataverse_ontology_query_sparql', {
    car_base64: carBase64,
    query: 'SELECT ?s WHERE { SERVICE <https://example.org/s> { ?s ?p ?o . } }',
  });
  assert.equal(badSparql.isError, true);
  assert.match(badSparql.text, /service-not-allowed/);
});

test('Worker HTTP: CAR import + receipt intact; /ontology/v1 schema, inspect, view, ops SQL/SPARQL, and fail-closed refusals', async () => {
  const s = fakeStore();
  const deps = { fetchImpl: s.fetchImpl, now: NOW };
  const env = { ...ENV, MAX_BLOCK_BYTES: '65536' };
  const snap = buildOntologySnapshot(demoSpec());

  // 1. Upload ontology snapshot CAR via existing POST /ipfs/ — verifies existing receipt contract stays intact
  const importRes = await workerHandle(
    new Request('https://yataverse.com/ipfs/', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/vnd.ipld.car',
      },
      body: snap.carBytes,
    }),
    env,
    deps,
  );
  assert.equal(importRes.status, 201);
  const imported = await importRes.json();
  assert.deepEqual(imported.roots, [snap.basisCid]);
  assert.equal(imported.verified, true);
  assert.equal(imported.receipt.v, 1);

  // 2. GET /ontology/v1/schema
  const schemaRes = await workerHandle(new Request('https://yataverse.com/ontology/v1/schema'), env, deps);
  assert.equal(schemaRes.status, 200);
  assert.equal((await schemaRes.json()).protocol, 'noun.verb');

  // 3. GET /ontology/v1/inspect/:cid
  const inspectRes = await workerHandle(new Request(`https://yataverse.com/ontology/v1/inspect/${snap.basisCid}`), env, deps);
  assert.equal(inspectRes.status, 200);
  const inspected = await inspectRes.json();
  assert.equal(inspected.operation, 'ontology.inspect');
  assert.equal(inspected.basisCid, snap.basisCid);

  // 4. GET /ontology/v1/view/:cid (html, svg, json)
  const htmlRes = await workerHandle(new Request(`https://yataverse.com/ontology/v1/view/${snap.basisCid}?format=html`), env, deps);
  assert.equal(htmlRes.status, 200);
  assert.match(htmlRes.headers.get('content-type'), /text\/html/);
  assert.ok(htmlRes.headers.get('content-security-policy'));
  const htmlBody = await htmlRes.text();
  assert.match(htmlBody, /data-operation="ontology\.query_sql"/);
  assert.ok(!FORBIDDEN_TOKENS.test(htmlBody));

  const svgRes = await workerHandle(new Request(`https://yataverse.com/ontology/v1/view/${snap.basisCid}?format=svg`), env, deps);
  assert.equal(svgRes.status, 200);
  assert.match(svgRes.headers.get('content-type'), /image\/svg\+xml/);

  // 5. POST /ontology/v1/ops/ontology.query_sql against stored basisCid
  const sqlRes = await workerHandle(
    new Request('https://yataverse.com/ontology/v1/ops/ontology.query_sql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        basisCid: snap.basisCid,
        query: 'SELECT t.id, a.name FROM tender t JOIN agency a ON t.agency_id = a.id',
      }),
    }),
    env,
    deps,
  );
  assert.equal(sqlRes.status, 200);
  const sqlJson = await sqlRes.json();
  assert.deepEqual(sqlJson.result.rows, [{ id: 't-1', name: 'Digital Agency' }]);

  // 6. POST /ontology/v1/ops/ontology.query_sparql against stored basisCid
  const sparqlRes = await workerHandle(
    new Request('https://yataverse.com/ontology/v1/ops/ontology.query_sparql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        basisCid: snap.basisCid,
        query: `PREFIX onto: <${DEFAULT_BASE_IRI}> SELECT ?amt WHERE { ?s onto:amount ?amt . }`,
      }),
    }),
    env,
    deps,
  );
  assert.equal(sparqlRes.status, 200);
  assert.deepEqual((await sparqlRes.json()).result.rows, [{ '?amt': 500 }]);

  // 7. Negative Worker checks: write SQL -> 400, remote SERVICE -> 400, READ_DENY_CIDS -> 451, unknown op -> 404
  const badSql = await workerHandle(
    new Request('https://yataverse.com/ontology/v1/ops/ontology.query_sql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ basisCid: snap.basisCid, query: 'DROP TABLE tender' }),
    }),
    env,
    deps,
  );
  assert.equal(badSql.status, 400);
  assert.equal((await badSql.json()).error, 'sql-write-refused');

  const badService = await workerHandle(
    new Request('https://yataverse.com/ontology/v1/ops/ontology.query_sparql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ basisCid: snap.basisCid, query: 'SELECT ?s WHERE { SERVICE <https://x.example/sp> { ?s ?p ?o . } }' }),
    }),
    env,
    deps,
  );
  assert.equal(badService.status, 400);
  assert.equal((await badService.json()).error, 'service-not-allowed');

  const denied = await workerHandle(
    new Request(`https://yataverse.com/ontology/v1/inspect/${snap.basisCid}`),
    { ...env, READ_DENY_CIDS: snap.basisCid },
    deps,
  );
  assert.equal(denied.status, 451);

  const unknownOp = await workerHandle(
    new Request('https://yataverse.com/ontology/v1/ops/ontology.mutate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
    env,
    deps,
  );
  assert.equal(unknownOp.status, 404);
});
