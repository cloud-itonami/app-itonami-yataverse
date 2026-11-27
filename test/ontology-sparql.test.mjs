import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOntologySnapshot, DEFAULT_BASE_IRI } from '../src/ontology.mjs';
import { executeSparql, parseSparql, algebraToEdn, ednToAlgebra, SparqlError } from '../src/ontology-sparql.mjs';
import { cidFor, CODEC_DAG_CBOR } from '../src/cid.mjs';
import { encodeDagCbor } from '../src/dag-cbor.mjs';

function makeSnapshot() {
  return buildOntologySnapshot({
    id: 'sparql-fixture',
    facts: [
      { id: 't1', connectorId: 'jp.kkj', status: 'open', title: 'Cloud Storage', jurisdiction: 'jp-national', amount: 100, note: 'urgent' },
      { id: 't2', connectorId: 'jp.kkj', status: 'open', title: 'Network Fabric', jurisdiction: 'jp-national', amount: 300 },
      { id: 't3', connectorId: 'jp.geps', status: 'awarded', title: 'City GIS', jurisdiction: 'jp-tokyo', amount: 200 },
    ],
    quads: [
      {
        subject: 'https://example.org/org/digital',
        predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        object: 'https://example.org/ns#Agency',
        graph: 'https://example.org/graph/directory',
      },
      {
        subject: 'https://example.org/org/digital',
        predicate: 'https://example.org/ns#label',
        object: { rdfType: 'literal', value: 'Digital Agency', language: 'en' },
        graph: 'https://example.org/graph/directory',
      },
    ],
  });
}

test('SPARQL: BGP joins, FILTER, OPTIONAL, ORDER BY DESC, LIMIT/OFFSET, aggregates', () => {
  const snap = makeSnapshot();

  // BGP join + FILTER + ORDER BY DESC + LIMIT
  const res = executeSparql(
    snap,
    `PREFIX onto: <${DEFAULT_BASE_IRI}>
     SELECT ?s ?title ?amount WHERE {
       ?s a onto:tender ;
          onto:status "open" ;
          onto:title ?title ;
          onto:amount ?amount .
       FILTER (?amount >= 100 && CONTAINS(?title, "o"))
     }
     ORDER BY DESC(?amount)
     LIMIT 2`,
    { basisCid: snap.basisCid },
  );
  assert.equal(res.form, 'select');
  assert.equal(res.readOnly, true);
  assert.equal(res.rowCount, 2);
  assert.equal(res.rows[0]['?title'], 'Network Fabric');
  assert.equal(res.rows[0]['?amount'], 300);
  assert.equal(res.rows[1]['?title'], 'Cloud Storage');
  assert.equal(res.rows[1]['?amount'], 100);

  // OPTIONAL preserves unmatched rows
  const opt = executeSparql(
    snap,
    `PREFIX onto: <${DEFAULT_BASE_IRI}>
     SELECT ?title ?note WHERE {
       ?s onto:status "open" ;
          onto:title ?title .
       OPTIONAL { ?s onto:note ?note . }
     }
     ORDER BY ASC(?title)`,
  );
  assert.equal(opt.rowCount, 2);
  assert.deepEqual(opt.rows[0], { '?title': 'Cloud Storage', '?note': 'urgent' });
  assert.deepEqual(opt.rows[1], { '?title': 'Network Fabric', '?note': null });

  // GROUP BY + COUNT + SUM + AVG
  const agg = executeSparql(
    snap,
    `PREFIX onto: <${DEFAULT_BASE_IRI}>
     SELECT ?status (COUNT(?s) AS ?cnt) (SUM(?amount) AS ?total) (AVG(?amount) AS ?avg) WHERE {
       ?s onto:status ?status ;
          onto:amount ?amount .
     }
     GROUP BY ?status
     ORDER BY DESC(?total)`,
  );
  assert.equal(agg.rowCount, 2);
  assert.deepEqual(agg.rows[0], { '?status': 'open', '?cnt': 2, '?total': 400, '?avg': 200 });
  assert.deepEqual(agg.rows[1], { '?status': 'awarded', '?cnt': 1, '?total': 200, '?avg': 200 });
});

test('SPARQL: UNION, GRAPH, ASK, CONSTRUCT, DESCRIBE, and EDN <-> JSON algebra round-trip', () => {
  const snap = makeSnapshot();

  // UNION
  const unionRes = executeSparql(
    snap,
    `PREFIX onto: <${DEFAULT_BASE_IRI}>
     SELECT ?title WHERE {
       { ?s onto:status "awarded" ; onto:title ?title . }
       UNION
       { ?s onto:note "urgent" ; onto:title ?title . }
     }
     ORDER BY ?title`,
  );
  assert.deepEqual(unionRes.rows, [{ '?title': 'City GIS' }, { '?title': 'Cloud Storage' }]);

  // Local named GRAPH
  const graphRes = executeSparql(
    snap,
    `PREFIX ex: <https://example.org/ns#>
     SELECT ?label WHERE {
       GRAPH <https://example.org/graph/directory> {
         ?s ex:label ?label .
       }
     }`,
  );
  assert.deepEqual(graphRes.rows, [{ '?label': 'Digital Agency' }]);

  // ASK
  const askTrue = executeSparql(snap, `PREFIX onto: <${DEFAULT_BASE_IRI}> ASK WHERE { ?s onto:status "awarded" . }`);
  assert.equal(askTrue.boolean, true);
  const askFalse = executeSparql(snap, `PREFIX onto: <${DEFAULT_BASE_IRI}> ASK WHERE { ?s onto:status "cancelled" . }`);
  assert.equal(askFalse.boolean, false);

  // CONSTRUCT
  const constructed = executeSparql(
    snap,
    `PREFIX onto: <${DEFAULT_BASE_IRI}>
     PREFIX ex: <https://example.org/ns#>
     CONSTRUCT { ?s ex:openTitle ?title . }
     WHERE { ?s onto:status "open" ; onto:title ?title . }`,
  );
  assert.equal(constructed.form, 'construct');
  assert.equal(constructed.count, 2);

  // DESCRIBE
  const described = executeSparql(
    snap,
    'DESCRIBE <https://example.org/org/digital>',
  );
  assert.equal(described.form, 'describe');
  assert.equal(described.count, 2);

  // EDN <-> JSON algebra round-trip matching kotoba.sparql/sparql.core
  const parsed = parseSparql(
    `PREFIX onto: <${DEFAULT_BASE_IRI}>
     SELECT DISTINCT ?title ?amount WHERE {
       ?s onto:status "open" ; onto:title ?title ; onto:amount ?amount .
       FILTER (?amount > 50)
     }
     ORDER BY DESC(?amount)
     LIMIT 5`,
  );
  const edn = algebraToEdn(parsed.algebra);
  assert.match(edn, /:sparql\/op :slice/);
  assert.match(edn, /:sparql\/op :order-by/);
  assert.match(edn, /:sparql\/op :bgp/);

  const roundTripped = ednToAlgebra(edn);
  assert.deepEqual(roundTripped, parsed.algebra);

  const viaEdn = executeSparql(snap, { edn });
  assert.equal(viaEdn.rowCount, 2);
  assert.equal(viaEdn.rows[0]['?title'], 'Network Fabric');
});

test('SPARQL: visibility filtering by jurisdiction / allowedSources', () => {
  const snap = makeSnapshot();
  const res = executeSparql(
    snap,
    `PREFIX onto: <${DEFAULT_BASE_IRI}>
     SELECT ?title WHERE { ?s onto:title ?title . } ORDER BY ?title`,
    { jurisdiction: 'jp-tokyo' },
  );
  assert.deepEqual(res.rows, [{ '?title': 'City GIS' }]);
});

test('SPARQL negative: fail-closed on SERVICE, FROM, update verbs, unsupported syntax, ReDoS, limits, basis mismatch', () => {
  const snap = makeSnapshot();

  // Remote SERVICE refused
  assert.throws(
    () => executeSparql(snap, 'SELECT ?s WHERE { SERVICE <https://dbpedia.org/sparql> { ?s ?p ?o . } }'),
    (e) => e instanceof SparqlError && e.code === 'service-not-allowed',
  );

  // Remote FROM dataset refused
  assert.throws(
    () => executeSparql(snap, 'SELECT ?s FROM <https://evil.example/data.ttl> WHERE { ?s ?p ?o . }'),
    (e) => e instanceof SparqlError && e.code === 'remote-dataset-not-allowed',
  );

  // Update / write verbs refused
  for (const q of [
    'INSERT DATA { <https://e/s> <https://e/p> "v" . }',
    'DELETE WHERE { ?s ?p ?o . }',
    'LOAD <https://evil.example/g.ttl>',
    'CLEAR ALL',
    'DROP DEFAULT',
  ]) {
    assert.throws(
      () => executeSparql(snap, q),
      (e) => e instanceof SparqlError && e.code === 'write-query-refused',
      `expected write-query-refused for: ${q}`,
    );
  }

  // Unsupported constructs
  for (const q of [
    'SELECT ?s WHERE { ?s ?p ?o . BIND("x" AS ?y) }',
    'SELECT ?s WHERE { ?s ?p ?o . MINUS { ?s ?p "x" . } }',
    'SELECT ?s WHERE { { SELECT ?s WHERE { ?s ?p ?o . } } }',
  ]) {
    assert.throws(
      () => executeSparql(snap, q),
      (e) => e instanceof SparqlError && e.code === 'sparql-unsupported-construct',
    );
  }

  // Unallowlisted FILTER function
  assert.throws(
    () => executeSparql(snap, 'SELECT ?s WHERE { ?s ?p ?o . FILTER(EVAL(?o)) }'),
    (e) => e instanceof SparqlError && e.code === 'sparql-unsupported-function',
  );

  // Backreference / lookahead patterns refused (linear-time NFA handles (a+)+$ safely in O(n))
  assert.throws(
    () => executeSparql(snap, 'SELECT ?s WHERE { ?s ?p ?o . FILTER(REGEX(?o, "(a+)\\\\1+")) }'),
    (e) => e instanceof SparqlError && e.code === 'sparql-regex-too-complex',
  );

  // Basis CID mismatch
  const wrongCid = cidFor(encodeDagCbor({ wrong: true }), CODEC_DAG_CBOR);
  assert.throws(
    () => executeSparql(snap, 'SELECT ?s WHERE { ?s ?p ?o . }', { basisCid: wrongCid }),
    (e) => e instanceof SparqlError && e.code === 'basis-cid-mismatch',
  );

  // Bounds enforcement
  assert.throws(
    () => executeSparql(snap, 'SELECT ?s ?p ?o WHERE { ?s ?p ?o . }', { maxScanSteps: 3 }),
    (e) => e instanceof SparqlError && e.code === 'scan-limit-exceeded',
  );
  assert.throws(
    () => executeSparql(snap, 'SELECT ?s ?p ?o WHERE { ?s ?p ?o . }', { maxSolutions: 2 }),
    (e) => e instanceof SparqlError && e.code === 'solution-limit-exceeded',
  );
});
