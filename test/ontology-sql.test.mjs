import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOntologySnapshot } from '../src/ontology.mjs';
import { executeSql, SqlError } from '../src/ontology-sql.mjs';
import { cidFor, CODEC_DAG_CBOR } from '../src/cid.mjs';
import { encodeDagCbor } from '../src/dag-cbor.mjs';

function makeSnapshot() {
  return buildOntologySnapshot({
    id: 'sql-fixture',
    objectTypes: [
      { id: 'agency', name: 'Agency', attributes: { name: 'string', jurisdiction: 'keyword' }, key: ['name'] },
    ],
    connectors: [
      { id: 'jp.agencies', name: 'Agency Dir', objectType: 'agency', status: 'implemented' },
    ],
    facts: [
      { id: 't1', connectorId: 'jp.kkj', status: 'open', title: 'Cloud Mesh', agency_id: 'a1', jurisdiction: 'jp-national', amount: 100 },
      { id: 't2', connectorId: 'jp.kkj', status: 'open', title: 'Zero Trust IAM', agency_id: 'a1', jurisdiction: 'jp-national', amount: 300 },
      { id: 't3', connectorId: 'jp.geps', status: 'awarded', title: 'City GIS', agency_id: 'a2', jurisdiction: 'jp-tokyo', amount: 200 },
      { id: 't4', connectorId: 'jp.geps', status: 'closed', title: 'Legacy Archival', agency_id: 'a3', jurisdiction: 'jp-osaka', amount: 50 },
      { id: 'a1', connectorId: 'jp.agencies', name: 'Digital Agency', jurisdiction: 'jp-national' },
      { id: 'a2', connectorId: 'jp.agencies', name: 'Tokyo Gov', jurisdiction: 'jp-tokyo' },
    ],
    joinMappings: [
      { name: 'tender_agency_view', leftType: 'tender', rightType: 'agency', leftKey: 'agency_id', rightKey: 'id', kind: 'inner' },
    ],
  });
}

test('SQL: SELECT, WHERE predicates, ORDER BY, LIMIT/OFFSET, DISTINCT', () => {
  const snap = makeSnapshot();

  const res = executeSql(
    snap,
    "SELECT id, title, amount FROM tender WHERE status = 'open' AND amount >= 100 ORDER BY amount DESC LIMIT 1 OFFSET 0",
    { basisCid: snap.basisCid },
  );
  assert.equal(res.basisCid, snap.basisCid);
  assert.equal(res.readOnly, true);
  assert.equal(res.rowCount, 1);
  assert.deepEqual(res.rows[0], { id: 't2', title: 'Zero Trust IAM', amount: 300 });

  // IN, LIKE, BETWEEN
  const res2 = executeSql(
    snap,
    "SELECT id FROM tender WHERE status IN ('open', 'awarded') AND title LIKE '%GIS%'",
  );
  assert.deepEqual(res2.rows, [{ id: 't3' }]);

  const res3 = executeSql(
    snap,
    'SELECT DISTINCT status FROM tender WHERE amount BETWEEN 100 AND 300 ORDER BY status ASC',
  );
  assert.deepEqual(res3.rows, [{ status: 'awarded' }, { status: 'open' }]);
});

test('SQL: INNER JOIN, LEFT JOIN, and materialized joinMappings view', () => {
  const snap = makeSnapshot();

  const inner = executeSql(
    snap,
    'SELECT t.id AS tender_id, a.name AS agency_name, t.amount FROM tender t INNER JOIN agency a ON t.agency_id = a.id ORDER BY t.id ASC',
  );
  assert.equal(inner.rowCount, 3);
  assert.deepEqual(inner.rows[0], { tender_id: 't1', agency_name: 'Digital Agency', amount: 100 });
  assert.deepEqual(inner.rows[2], { tender_id: 't3', agency_name: 'Tokyo Gov', amount: 200 });

  const left = executeSql(
    snap,
    'SELECT t.id AS tender_id, a.name AS agency_name FROM tender t LEFT JOIN agency a ON t.agency_id = a.id WHERE a.name IS NULL',
  );
  assert.deepEqual(left.rows, [{ tender_id: 't4', agency_name: null }]);

  const joinView = executeSql(snap, 'SELECT tender_id, agency_name FROM tender_agency_view ORDER BY tender_id ASC');
  assert.equal(joinView.rowCount, 3);
});

test('SQL: GROUP BY, HAVING, COUNT/SUM/AVG/MIN/MAX aggregates', () => {
  const snap = makeSnapshot();

  const agg = executeSql(
    snap,
    'SELECT status, COUNT(*) AS cnt, SUM(amount) AS total, AVG(amount) AS avg_amt, MIN(amount) AS min_amt, MAX(amount) AS max_amt FROM tender GROUP BY status ORDER BY total DESC',
  );
  assert.equal(agg.rowCount, 3);
  assert.deepEqual(agg.rows[0], { status: 'open', cnt: 2, total: 400, avg_amt: 200, min_amt: 100, max_amt: 300 });
  assert.deepEqual(agg.rows[1], { status: 'awarded', cnt: 1, total: 200, avg_amt: 200, min_amt: 200, max_amt: 200 });

  const having = executeSql(
    snap,
    'SELECT ontology_source, COUNT(DISTINCT status) AS statuses FROM tender GROUP BY ontology_source HAVING COUNT(*) >= 2 ORDER BY ontology_source ASC',
  );
  assert.deepEqual(having.rows, [
    { ontology_source: 'jp.geps', statuses: 2 },
    { ontology_source: 'jp.kkj', statuses: 1 },
  ]);

  // Whole-table aggregate on empty filtered result
  const emptyAgg = executeSql(snap, "SELECT COUNT(*) AS c, SUM(amount) AS s FROM tender WHERE status = 'nonexistent'");
  assert.deepEqual(emptyAgg.rows, [{ c: 0, s: null }]);
});

test('SQL: visibility policy filtering (jurisdiction, allowedSources, custom visible)', () => {
  const snap = makeSnapshot();

  const national = executeSql(snap, 'SELECT id FROM tender ORDER BY id ASC', { jurisdiction: 'jp-national' });
  assert.deepEqual(national.rows, [{ id: 't1' }, { id: 't2' }]);

  const gepsOnly = executeSql(snap, 'SELECT id FROM tender ORDER BY id ASC', { allowedSources: ['jp.geps'] });
  assert.deepEqual(gepsOnly.rows, [{ id: 't3' }, { id: 't4' }]);
});

test('SQL negative: fail-closed on writes, DDL, stacked queries, subqueries, arbitrary functions, limits, basis mismatch', () => {
  const snap = makeSnapshot();

  const writeQueries = [
    "INSERT INTO tender VALUES ('t9', 'open')",
    "UPDATE tender SET status = 'closed'",
    'DELETE FROM tender',
    'DROP TABLE tender',
    'ALTER TABLE tender ADD COLUMN x INT',
    'CREATE TABLE evil (id INT)',
    'TRUNCATE TABLE tender',
    'PRAGMA table_info(tender)',
    'SELECT * INTO evil FROM tender',
    'SELECT * FROM tender; DROP TABLE tender',
  ];
  for (const q of writeQueries) {
    assert.throws(
      () => executeSql(snap, q),
      (e) => e instanceof SqlError && e.code === 'sql-write-refused',
      `expected sql-write-refused for: ${q}`,
    );
  }

  // Unsupported constructs
  for (const q of [
    'WITH cte AS (SELECT * FROM tender) SELECT * FROM cte',
    'SELECT id FROM tender UNION SELECT id FROM agency',
    'SELECT * FROM (SELECT id FROM tender) sub',
    'SELECT id FROM tender WHERE id IN (SELECT id FROM agency)',
    'SELECT COUNT(*) OVER () FROM tender',
  ]) {
    assert.throws(
      () => executeSql(snap, q),
      (e) => e instanceof SqlError && e.code === 'sql-unsupported-construct',
      `expected sql-unsupported-construct for: ${q}`,
    );
  }

  // Unallowlisted arbitrary function
  assert.throws(
    () => executeSql(snap, 'SELECT SLEEP(5) FROM tender'),
    (e) => e instanceof SqlError && e.code === 'sql-unsupported-function',
  );

  // Basis CID mismatch
  const wrongCid = cidFor(encodeDagCbor({ other: 1 }), CODEC_DAG_CBOR);
  assert.throws(
    () => executeSql(snap, 'SELECT id FROM tender', { basisCid: wrongCid }),
    (e) => e instanceof SqlError && e.code === 'basis-cid-mismatch',
  );

  // Bounds enforcement: scan limit, result row limit, output byte limit
  assert.throws(
    () => executeSql(snap, 'SELECT id FROM tender', { maxScanRows: 2 }),
    (e) => e instanceof SqlError && e.code === 'scan-limit-exceeded',
  );
  assert.throws(
    () => executeSql(snap, 'SELECT id FROM tender', { maxResultRows: 2 }),
    (e) => e instanceof SqlError && e.code === 'result-limit-exceeded',
  );
  assert.throws(
    () => executeSql(snap, 'SELECT * FROM tender', { maxOutputBytes: 40 }),
    (e) => e instanceof SqlError && e.code === 'output-size-exceeded',
  );
});
