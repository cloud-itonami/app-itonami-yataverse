import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOntologySnapshot,
  verifyOntologySnapshot,
  createRegistry,
  conforms,
  tagFact,
  taggedConforms,
  ingestJsonLd,
  scanQuads,
  dagCborLinks,
  OntologyError,
  DEFAULT_BASE_IRI,
} from '../src/ontology.mjs';
import { cidFor, CODEC_DAG_CBOR } from '../src/cid.mjs';
import { encodeDagCbor } from '../src/dag-cbor.mjs';
import { encodeCarV1 } from '../src/car.mjs';

function sampleSpec() {
  return {
    id: 'jp-procurement-demo',
    createdAt: '2026-11-27T00:00:00Z',
    objectTypes: [
      {
        id: 'agency',
        name: 'Procurement Agency',
        attributes: { name: 'string', jurisdiction: 'keyword' },
        key: ['name'],
      },
    ],
    connectors: [
      {
        id: 'jp.agencies',
        name: 'Japan Government Agency Directory',
        objectType: 'agency',
        status: 'implemented',
      },
    ],
    facts: [
      {
        id: 't-100',
        connectorId: 'jp.kkj',
        status: 'open',
        title: 'Cloud Storage Modernization',
        agency_id: 'ag-digital',
        jurisdiction: 'jp-national',
        amount: 12500000,
        'ontology/fetched-at': '2026-11-27T00:00:00Z',
        'ontology/confidence': 0.95,
      },
      {
        id: 't-101',
        connectorId: 'jp.geps',
        status: 'awarded',
        title: 'Municipal GIS Portal',
        agency_id: 'ag-tokyo',
        jurisdiction: 'jp-tokyo',
        amount: 8400000.5,
        'ontology/confidence': 0.88,
      },
      {
        id: 'ag-digital',
        connectorId: 'jp.agencies',
        name: 'Digital Agency',
        jurisdiction: 'jp-national',
      },
      {
        id: 'ag-tokyo',
        connectorId: 'jp.agencies',
        name: 'Tokyo Metropolitan Government',
        jurisdiction: 'jp-tokyo',
      },
    ],
    joinMappings: [
      {
        name: 'tender_with_agency',
        leftType: 'tender',
        rightType: 'agency',
        leftKey: 'agency_id',
        rightKey: 'id',
        kind: 'inner',
      },
    ],
  };
}

test('ontology registry: default :tender + :jp.kkj/:jp.geps provenance & conformance', () => {
  const reg = createRegistry();
  assert.equal(conforms(reg, ':tender', { status: 'open', title: 'Test' }), true);
  assert.equal(conforms(reg, 'tender', { title: 'Missing status' }), false);

  const tagged = tagFact(':jp.kkj', { id: 't-1', status: 'open', jurisdiction: 'jp-national' }, {
    registry: reg,
    fetchedAt: '2026-11-27T00:00:00Z',
    confidence: 0.9,
  });
  assert.equal(tagged['ontology/type'], 'tender');
  assert.equal(tagged['ontology/source'], 'jp.kkj');
  assert.equal(tagged['ontology/confidence'], 0.9);
  assert.equal(taggedConforms(reg, 'jp.kkj', tagged), true);
  assert.equal(taggedConforms(reg, 'jp.geps', tagged), false);

  // Fail closed on unregistered connector
  assert.throws(
    () => tagFact('jp.unknown', { id: 't-2', status: 'open' }, { registry: reg }),
    (e) => e instanceof OntologyError && e.code === 'unregistered-connector',
  );
});

test('IPLD DAG-CBOR snapshot: canonical CIDv1, tag-42 links, deterministic CAR round-trip', () => {
  const snap1 = buildOntologySnapshot(sampleSpec());
  const snap2 = buildOntologySnapshot(sampleSpec());

  assert.equal(snap1.basisCid, snap2.basisCid);
  assert.match(snap1.basisCid, /^bafyrei/);
  assert.equal(snap1.blocks.size, 5); // root + registry + facts + quads + joins

  // Root block links via DAG-CBOR tag-42 to all 4 child blocks
  const rootLinks = dagCborLinks(snap1.blocks.get(snap1.basisCid));
  assert.equal(rootLinks.length, 4);
  for (const childCid of [snap1.blockCids.registry, snap1.blockCids.facts, snap1.blockCids.quads, snap1.blockCids.joins]) {
    assert.ok(rootLinks.includes(childCid), `root missing tag-42 link to ${childCid}`);
  }

  // CAR round-trip verification (including decimal preservation via $awaiType wrapper)
  const verified = verifyOntologySnapshot(snap1.carBytes, { expectedBasisCid: snap1.basisCid });
  assert.equal(verified.basisCid, snap1.basisCid);
  assert.equal(verified.facts.length, 4);
  const t101 = verified.facts.find((f) => f.id === 't-101');
  assert.equal(t101.amount, 8400000.5);
  assert.equal(t101['ontology/confidence'], 0.88);
  assert.ok(verified.tables.has('tender'));
  assert.ok(verified.tables.has('agency'));
  assert.ok(verified.tables.has('tender_with_agency'));
  assert.equal(verified.tables.get('tender_with_agency').rows.length, 2);
});

test('JSON-LD ingestion: accepts inline & CID-pinned contexts; refuses unpinned remote @context', () => {
  const pinnedCtxObj = {
    ex: 'https://example.org/ns#',
    label: 'ex:label',
    related: { '@id': 'ex:related', '@type': '@id' },
  };
  const pinnedCtxCid = cidFor(encodeDagCbor(pinnedCtxObj), CODEC_DAG_CBOR);

  const quads = ingestJsonLd(
    {
      '@context': 'https://example.org/contexts/demo.jsonld',
      '@id': 'https://example.org/item/1',
      '@type': 'ex:Item',
      label: 'Pinned Context Item',
      related: 'https://example.org/item/2',
    },
    {
      pinnedContexts: {
        'https://example.org/contexts/demo.jsonld': { cid: pinnedCtxCid, context: pinnedCtxObj },
      },
    },
  );
  assert.equal(quads.length, 3);
  assert.ok(quads.some((q) => q.predicate.value === 'https://example.org/ns#label' && q.object.value === 'Pinned Context Item'));
  assert.ok(quads.some((q) => q.predicate.value === 'https://example.org/ns#related' && q.object.rdfType === 'iri'));

  // Negative: remote @context without pinnedContexts MUST fail closed
  assert.throws(
    () => ingestJsonLd({ '@context': 'https://schema.org/', '@id': 'https://example.org/x', name: 'bad' }),
    (e) => e instanceof OntologyError && e.code === 'remote-context-refused',
  );

  // Negative: remote @import inside inline @context MUST fail closed
  assert.throws(
    () => ingestJsonLd({ '@context': { '@import': 'https://schema.org/ext.jsonld' }, '@id': 'https://example.org/x' }),
    (e) => e instanceof OntologyError && e.code === 'remote-context-refused',
  );

  // Negative: pinned context with wrong CID MUST fail closed
  assert.throws(
    () => ingestJsonLd(
      { '@context': 'https://example.org/contexts/demo.jsonld', '@id': 'https://example.org/x' },
      {
        pinnedContexts: {
          'https://example.org/contexts/demo.jsonld': {
            cid: cidFor(encodeDagCbor({ other: 'ctx' }), CODEC_DAG_CBOR),
            context: pinnedCtxObj,
          },
        },
      },
    ),
    (e) => e instanceof OntologyError && e.code === 'pinned-context-cid-mismatch',
  );
});

test('negative: invalid CID, tampered block, missing closure, stray block, bad provenance rejected', () => {
  const snap = buildOntologySnapshot(sampleSpec());

  // Wrong expectedBasisCid
  const fakeCid = cidFor(encodeDagCbor({ fake: true }), CODEC_DAG_CBOR);
  assert.throws(
    () => verifyOntologySnapshot(snap.carBytes, { expectedBasisCid: fakeCid }),
    (e) => e instanceof OntologyError && e.code === 'basis-cid-mismatch',
  );

  // Tampered bytes inside a block map
  const tampered = new Map(snap.blocks);
  const origFactsBytes = tampered.get(snap.blockCids.facts);
  const flipped = new Uint8Array(origFactsBytes);
  flipped[flipped.length - 1] ^= 0xff;
  tampered.set(snap.blockCids.facts, flipped);
  assert.throws(
    () => verifyOntologySnapshot(tampered, { rootCid: snap.basisCid }),
    (e) => e instanceof OntologyError && e.code === 'invalid-block',
  );

  // Incomplete closure (missing quads block)
  const incomplete = new Map(snap.blocks);
  incomplete.delete(snap.blockCids.quads);
  assert.throws(
    () => verifyOntologySnapshot(incomplete, { rootCid: snap.basisCid }),
    (e) => e instanceof OntologyError && e.code === 'closure-incomplete',
  );

  // Unreachable extra block in CAR
  const extraBytes = encodeDagCbor({ stray: 1 });
  const extraCid = cidFor(extraBytes, CODEC_DAG_CBOR);
  const carWithStray = encodeCarV1([snap.basisCid], [...snap.blockList, { cid: extraCid, bytes: extraBytes }]);
  assert.throws(
    () => verifyOntologySnapshot(carWithStray),
    (e) => e instanceof OntologyError && e.code === 'block-not-reachable',
  );

  // Unregistered connector in buildOntologySnapshot
  assert.throws(
    () => buildOntologySnapshot({ facts: [{ id: 'x', connectorId: 'unregistered.src', status: 'open' }] }),
    (e) => e instanceof OntologyError && e.code === 'unregistered-connector',
  );

  // Missing required attribute (`status`) for :tender
  assert.throws(
    () => buildOntologySnapshot({ facts: [{ id: 'x', connectorId: 'jp.kkj', title: 'No status field' }] }),
    (e) => e instanceof OntologyError && e.code === 'fact-does-not-conform',
  );
});

test('scanQuads enforces required visibility predicate and maxScanned bound', () => {
  const snap = buildOntologySnapshot(sampleSpec());

  // Missing visible predicate -> fail-closed (datalog.query contract)
  assert.throws(
    () => scanQuads(snap, [null, null, null]),
    (e) => e instanceof OntologyError && e.code === 'visibility-predicate-required',
  );

  // Explicit visible predicate works
  const statusPred = `${DEFAULT_BASE_IRI}status`;
  const allStatus = scanQuads(snap, [null, statusPred, null], () => true);
  assert.equal(allStatus.length, 2);

  const openOnly = scanQuads(snap, [null, statusPred, null], (q) => q.object.value === 'open');
  assert.equal(openOnly.length, 1);

  // Exceeding maxScanned fails closed
  assert.throws(
    () => scanQuads(snap, [null, null, null], () => true, { maxScanned: 2 }),
    (e) => e instanceof OntologyError && e.code === 'scan-limit-exceeded',
  );
});
