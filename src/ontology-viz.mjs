// Reusable zero-dependency IPLD / Ontology Visualization Library.
//
// Builds a canonical layered graph model (nodes, edges, layers, joins, coverage) from:
// - Verified IPLD / DAG-CBOR OntologySnapshots (src/ontology.mjs)
// - kotoba.ontology / kotoba.ontology.connector provenance metadata
// - EAVT / RDF quads and external join mappings
//
// Renders:
// - Canonical JSON graph model & canonical DAG-CBOR graph encoding (CIDv1 sha2-256)
// - Standalone deterministic, XSS-safe SVG graph
// - Interactive Semantic HTML5 Ontology Viewer (SVG + Node Inspector + SQL/SPARQL Console + Join Coverage)
// - Yataverse root landing page with immediate Ontology Viewer entry
//
// Zero external UI frameworks; pure semantic HTML5 + minimal inline CSS/JS; read-only & fail-closed.

import { cidFor, parseCid, CODEC_DAG_CBOR, SHA2_256 } from './cid.mjs';
import { encodeDagCbor } from './dag-cbor.mjs';
import {
  buildOntologySnapshot,
  toDagCborSafe,
  normalizeKeyword,
  clampLimit,
  compareCodeUnits,
  assertSafeKey,
  OntologyError,
} from './ontology.mjs';

export const ONTOLOGY_GRAPH_SCHEMA = 'yataverse.ontology.graph/v1';
export const MAX_GRAPH_NODES = 500;
export const ENDPOINT_PATH_PATTERN = /^\/[A-Za-z0-9/_-]*$/;

/** Validate an internal relative endpoint path (prevents open-redirect / javascript: injection). */
export function assertSafeEndpointPath(pathValue, name) {
  if (typeof pathValue !== 'string' || !ENDPOINT_PATH_PATTERN.test(pathValue) || pathValue.includes('//')) {
    throw new OntologyError('invalid-endpoint-path', `${name} must match /^\\/[A-Za-z0-9\\/_-]*$/`);
  }
  return pathValue;
}

/** XML / HTML attribute and text escaping for XSS-safe SVG and HTML rendering. */
export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape JSON embedded inside <script type="application/json"> (XSS + JS line-separator safe). */
export function safeJsonScript(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Static inline viewer script exported verbatim so HTTP servers can compute its exact
 * CSP SHA-256 digest (`script-src 'sha256-...'`) without using `'unsafe-inline'`.
 */
export const VIEWER_CLIENT_SCRIPT = `
    (function () {
      var meta = JSON.parse(document.getElementById('yataverse-semantic-schema').textContent);
      var stateEl = document.getElementById('yataverse-screen-state');
      var screenState = stateEl ? JSON.parse(stateEl.textContent) : {
        screenId: 'yataverse.ontology.viewer',
        status: 'ready',
        basisCid: meta.basisCid,
        activeTab: 'graph',
        selectedNodeId: null,
        ops: (meta.schema && meta.schema.operations ? meta.schema.operations.map(function (o) { return o.operation; }) : []),
      };
      var nodesById = Object.create(null);
      (meta.graph.nodes || []).forEach(function (n) { nodesById[n.id] = n; });
      var edges = meta.graph.edges || [];

      function syncScreenState(patch) {
        if (patch) {
          Object.keys(patch).forEach(function (k) { screenState[k] = patch[k]; });
        }
        document.body.setAttribute('data-screen-id', String(screenState.screenId || ''));
        document.body.setAttribute('data-status', String(screenState.status || ''));
        document.body.setAttribute('data-active-tab', String(screenState.activeTab || ''));
        document.body.setAttribute('data-selected-node-id', String(screenState.selectedNodeId || ''));
        document.body.setAttribute('data-active-layers', Array.isArray(screenState.activeLayers) ? screenState.activeLayers.join(',') : '');
        if (stateEl) stateEl.textContent = JSON.stringify(screenState);
      }

      var layerBoxes = Array.prototype.slice.call(document.querySelectorAll('[data-layer-toggle]'));
      function applyLayerFilter(activeList) {
        var activeSet = Object.create(null);
        activeList.forEach(function (id) { activeSet[id] = true; });
        var visibleNodeIds = Object.create(null);
        var visibleNodeCount = 0;
        document.querySelectorAll('.yv-node').forEach(function (el) {
          var layer = el.getAttribute('data-layer');
          var show = Boolean(activeSet[layer]);
          el.style.display = show ? '' : 'none';
          if (show) {
            visibleNodeIds[el.getAttribute('data-node-id')] = true;
            visibleNodeCount += 1;
          }
        });
        var visibleEdgeCount = 0;
        edges.forEach(function (e) {
          var show = Boolean(visibleNodeIds[e.from] && visibleNodeIds[e.to]);
          document.querySelectorAll('[data-edge-id="' + e.id + '"]').forEach(function (el) {
            el.style.display = show ? '' : 'none';
          });
          if (show) visibleEdgeCount += 1;
        });
        layerBoxes.forEach(function (cb) { cb.checked = Boolean(activeSet[cb.getAttribute('data-layer-toggle')]); });
        var nextSelected = screenState.selectedNodeId && visibleNodeIds[screenState.selectedNodeId] ? screenState.selectedNodeId : null;
        if (!nextSelected) {
          document.getElementById('yv-inspector-summary').textContent = visibleNodeCount === 0
            ? 'No active layers selected (0 nodes, 0 edges).'
            : 'Select any connector, object type, or fact node in the graph.';
          document.getElementById('yv-inspector-json').textContent = '{}';
        }
        syncScreenState({ activeLayers: activeList, visibleNodeCount: visibleNodeCount, visibleEdgeCount: visibleEdgeCount, selectedNodeId: nextSelected });
      }

      if (layerBoxes.length) {
        layerBoxes.forEach(function (cb) {
          cb.addEventListener('change', function () {
            var selected = layerBoxes.filter(function (b) { return b.checked; }).map(function (b) { return b.getAttribute('data-layer-toggle'); });
            applyLayerFilter(selected);
          });
        });
        var allBtn = document.getElementById('yv-layers-all');
        var clearBtn = document.getElementById('yv-layers-clear');
        if (allBtn) allBtn.addEventListener('click', function () {
          applyLayerFilter(layerBoxes.map(function (b) { return b.getAttribute('data-layer-toggle'); }));
        });
        if (clearBtn) clearBtn.addEventListener('click', function () { applyLayerFilter([]); });
      }

      var tabs = Array.prototype.slice.call(document.querySelectorAll('[role="tab"]'));
      var panels = Array.prototype.slice.call(document.querySelectorAll('[role="tabpanel"]'));

      function activateTab(tabName, shouldFocus) {
        tabs.forEach(function (t) {
          var active = t.getAttribute('data-tab') === tabName;
          t.setAttribute('aria-selected', active ? 'true' : 'false');
          t.setAttribute('tabindex', active ? '0' : '-1');
          if (active && shouldFocus) t.focus();
        });
        panels.forEach(function (p) {
          var active = p.getAttribute('data-tab-panel') === tabName;
          p.hidden = !active;
        });
        syncScreenState({ activeTab: tabName });
      }

      var tablist = document.getElementById('yv-tablist');
      if (tablist && tabs.length) {
        tabs.forEach(function (t) {
          t.addEventListener('click', function () { activateTab(t.getAttribute('data-tab'), false); });
        });
        tablist.addEventListener('keydown', function (ev) {
          var idx = tabs.indexOf(document.activeElement);
          if (idx < 0) return;
          var nextIdx = idx;
          if (ev.key === 'ArrowRight') nextIdx = (idx + 1) % tabs.length;
          else if (ev.key === 'ArrowLeft') nextIdx = (idx - 1 + tabs.length) % tabs.length;
          else if (ev.key === 'Home') nextIdx = 0;
          else if (ev.key === 'End') nextIdx = tabs.length - 1;
          else return;
          ev.preventDefault();
          activateTab(tabs[nextIdx].getAttribute('data-tab'), true);
        });
      }

      function showNode(id) {
        var n = Object.prototype.hasOwnProperty.call(nodesById, id) ? nodesById[id] : null;
        if (!n) return;
        document.querySelectorAll('.yv-node').forEach(function (el) {
          el.setAttribute('data-selected', el.getAttribute('data-node-id') === id ? 'true' : 'false');
        });
        var rel = edges.filter(function (e) { return e.from === id || e.to === id; });
        document.getElementById('yv-inspector-summary').textContent = n.layer + ' · ' + n.label + ' (' + rel.length + ' edges)';
        document.getElementById('yv-inspector-json').textContent = JSON.stringify({ node: n, edges: rel }, null, 2);
        syncScreenState({ selectedNodeId: id });
      }

      document.querySelectorAll('.yv-node').forEach(function (el) {
        el.addEventListener('click', function () { showNode(el.getAttribute('data-node-id')); });
        el.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); showNode(el.getAttribute('data-node-id')); }
        });
      });
      if (meta.graph.nodes && meta.graph.nodes.length > 0) showNode(meta.graph.nodes[0].id);
      syncScreenState({ status: 'ready' });

      function renderResultTable(container, columns, rows) {
        container.textContent = '';
        if (!Array.isArray(rows) || rows.length === 0) return;
        var cols = Array.isArray(columns) && columns.length ? columns : Object.keys(rows[0]);
        var table = document.createElement('table');
        var thead = document.createElement('thead');
        var trHead = document.createElement('tr');
        cols.forEach(function (c) { var th = document.createElement('th'); th.textContent = c; trHead.appendChild(th); });
        thead.appendChild(trHead);
        table.appendChild(thead);
        var tbody = document.createElement('tbody');
        rows.slice(0, 100).forEach(function (r) {
          var tr = document.createElement('tr');
          cols.forEach(function (c) {
            var td = document.createElement('td');
            td.textContent = r[c] === null || r[c] === undefined ? '' : String(r[c]);
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        container.appendChild(table);
      }

      function bindConsole(formId, inputId, tableId, outId, endpoint, op) {
        var form = document.getElementById(formId);
        var input = document.getElementById(inputId);
        var tableEl = document.getElementById(tableId);
        var out = document.getElementById(outId);
        if (!form) return;
        form.addEventListener('submit', async function (ev) {
          ev.preventDefault();
          syncScreenState({ status: 'running' });
          out.textContent = 'Running ' + op + '...';
          try {
            var payload = { query: input.value };
            if (!meta.isSeededDefault) payload.basisCid = meta.basisCid;
            var res = await fetch(endpoint, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            });
            var data = await res.json();
            if (data && data.result && Array.isArray(data.result.rows)) {
              renderResultTable(tableEl, data.result.columns || data.result.variables, data.result.rows);
            } else {
              tableEl.textContent = '';
            }
            out.textContent = JSON.stringify(data, null, 2);
            syncScreenState({ status: res.ok ? 'ready' : 'error' });
          } catch (err) {
            out.textContent = 'Error: ' + String(err);
            syncScreenState({ status: 'error' });
          }
        });
      }

      bindConsole('yv-sql-form', 'yv-sql-input', 'yv-sql-table', 'yv-sql-out', meta.sqlEndpoint, 'ontology.query_sql');
      bindConsole('yv-sparql-form', 'yv-sparql-input', 'yv-sparql-table', 'yv-sparql-out', meta.sparqlEndpoint, 'ontology.query_sparql');
    })();
  `;

/**
 * Deterministic seeded default ontology snapshot using kotoba.ontology (:tender)
 * and kotoba.ontology.connector (:jp.kkj, :jp.geps) + agency external join mapping.
 */
let cachedDefaultSnapshot = null;
export function createDefaultOntologySnapshot() {
  if (cachedDefaultSnapshot) return cachedDefaultSnapshot;
  cachedDefaultSnapshot = buildOntologySnapshot({
    id: 'yataverse-seeded-kotoba-ontology',
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
        name: 'Japan Public Agency Registry',
        objectType: 'agency',
        status: 'implemented',
      },
    ],
    facts: [
      {
        id: 'kkj-2026-001',
        connectorId: 'jp.kkj',
        status: 'open',
        title: 'Content-Addressed Archive Gateway Pilot',
        agency_id: 'ag-digital',
        jurisdiction: 'jp-national',
        amount: 12000000,
        'ontology/fetched-at': '2026-11-27T00:00:00Z',
        'ontology/confidence': 0.96,
      },
      {
        id: 'geps-2026-042',
        connectorId: 'jp.geps',
        status: 'awarded',
        title: 'Municipal Open-Data Catalog Federation',
        agency_id: 'ag-tokyo',
        jurisdiction: 'jp-tokyo',
        amount: 8500000,
        'ontology/fetched-at': '2026-11-27T00:00:00Z',
        'ontology/confidence': 0.92,
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
  });
  return cachedDefaultSnapshot;
}

/** Compute external join coverage rows and summary statistics for a snapshot. */
export function computeJoinCoverage(snapshot) {
  const joins = [];
  for (const j of snapshot.joinMappings ?? []) {
    const leftRows = snapshot.tables?.get(j.leftType.toLowerCase())?.rows ?? [];
    const rightRows = snapshot.tables?.get(j.rightType.toLowerCase())?.rows ?? [];
    const lk = j.leftKey.replace(/[./-]/g, '_');
    const rk = j.rightKey.replace(/[./-]/g, '_');
    const rightCounts = new Map();
    for (const r of rightRows) {
      if (r[rk] !== undefined && r[rk] !== null) {
        const k = String(r[rk]);
        rightCounts.set(k, (rightCounts.get(k) ?? 0) + 1);
      }
    }
    let matchedLeft = 0;
    let matchedRows = 0;
    for (const l of leftRows) {
      if (l[lk] !== undefined && l[lk] !== null) {
        const cnt = rightCounts.get(String(l[lk])) ?? 0;
        if (cnt > 0) {
          matchedLeft += 1;
          matchedRows += cnt;
        }
      }
    }
    const coverageRatio = leftRows.length > 0 ? Math.round((matchedLeft / leftRows.length) * 1000) / 1000 : 0;
    joins.push({
      name: j.name,
      leftType: j.leftType,
      rightType: j.rightType,
      leftKey: j.leftKey,
      rightKey: j.rightKey,
      kind: j.kind,
      leftCount: leftRows.length,
      rightCount: rightRows.length,
      matchedLeft,
      matchedRows,
      coverageRatio,
    });
  }
  return joins;
}

/**
 * Build the canonical layered ontology graph model (`nodes`, `edges`, `layers`, `joins`, `coverage`).
 * Pure function, deterministic ordering, bounded by `maxNodes` (1..500) and `maxEdges = maxNodes * 8`.
 */
export function buildOntologyGraph(snapshot, { maxNodes = 64, maxEdges, includeRdfSubjects = false, activeLayers } = {}) {
  const boundNodes = clampLimit(maxNodes, 64, MAX_GRAPH_NODES, 'maxNodes', OntologyError);
  const hardMaxEdges = boundNodes * 8;
  const boundEdges = maxEdges === undefined
    ? hardMaxEdges
    : clampLimit(maxEdges, hardMaxEdges, hardMaxEdges, 'maxEdges', OntologyError);

  let activeLayerSet = null;
  if (activeLayers !== undefined && activeLayers !== null) {
    if (!Array.isArray(activeLayers) || !activeLayers.every((x) => typeof x === 'string')) {
      throw new OntologyError('invalid-active-layers', 'activeLayers must be an array of layer ids');
    }
    activeLayerSet = new Set(activeLayers);
  }

  const nodes = [];
  const edges = [];
  const nodeMap = new Map();
  let edgesTruncated = false;

  const addNode = (id, label, layer, meta = {}) => {
    if (activeLayerSet !== null && !activeLayerSet.has(layer)) return false;
    if (nodeMap.has(id) || nodes.length >= boundNodes) return false;
    const node = { id, label, kind: layer, layer, meta };
    nodeMap.set(id, node);
    nodes.push(node);
    return true;
  };

  let edgeSeq = 0;
  const addEdge = (from, to, label, kind, meta = {}) => {
    if (!nodeMap.has(from) || !nodeMap.has(to)) return false;
    if (edges.length >= boundEdges) {
      edgesTruncated = true;
      return false;
    }
    edges.push({ id: `e${++edgeSeq}`, from, to, label, kind, meta });
    return true;
  };

  // Canonical UTF-16 code-unit input ordering (independent of caller array order & locale):
  // connectors by id, objectTypes by id, facts by (ontology/type, id), joins by name.
  const sortedConnectors = [...snapshot.registry.connectors].sort((a, b) => compareCodeUnits(a.id, b.id));
  const sortedObjectTypes = [...snapshot.registry.objectTypes].sort((a, b) => compareCodeUnits(a.id, b.id));
  const sortedFacts = [...snapshot.facts].sort((a, b) => {
    const t = compareCodeUnits(a['ontology/type'], b['ontology/type']);
    return t !== 0 ? t : compareCodeUnits(a.id, b.id);
  });

  // Layer 1: Connectors
  for (const c of sortedConnectors) {
    addNode(`connector:${c.id}`, c.id, 'connector', {
      name: c.name,
      objectType: c.objectType,
      status: c.status,
      ...(c.repo ? { repo: c.repo } : {}),
    });
  }

  // Layer 2: Object Types
  for (const t of sortedObjectTypes) {
    addNode(`type:${t.id}`, t.id, 'object-type', {
      name: t.name,
      requiredAttributes: Object.keys(t.attributes).sort(compareCodeUnits),
      key: t.key,
    });
  }

  // Connector -> ObjectType provenance edges
  for (const c of sortedConnectors) {
    addEdge(`connector:${c.id}`, `type:${c.objectType}`, 'produces', 'provenance', {
      connectorId: c.id,
      objectType: c.objectType,
    });
  }

  // External join coverage + ObjectType <-> ObjectType join edges
  const joins = computeJoinCoverage(snapshot).sort((a, b) => compareCodeUnits(a.name, b.name));
  for (const j of joins) {
    addEdge(`type:${j.leftType}`, `type:${j.rightType}`, `${j.name} (${j.leftKey}=${j.rightKey})`, 'join', {
      joinName: j.name,
      kind: j.kind,
      matchedRows: j.matchedRows,
      coverageRatio: j.coverageRatio,
    });
  }

  // Layer 3: Facts (only keep references to facts actually added into nodeMap)
  const includedFacts = [];
  for (const f of sortedFacts) {
    if (nodes.length >= boundNodes) break;
    const typeId = f['ontology/type'];
    const nid = `fact:${typeId}:${f.id}`;
    const added = addNode(nid, `${typeId}:${f.id}`, 'fact', {
      id: f.id,
      'ontology/type': typeId,
      'ontology/source': f['ontology/source'],
      ...(f['ontology/fetched-at'] ? { 'ontology/fetched-at': f['ontology/fetched-at'] } : {}),
      ...(f['ontology/confidence'] !== undefined ? { 'ontology/confidence': f['ontology/confidence'] } : {}),
      ...(f.status !== undefined ? { status: f.status } : {}),
      ...(f.title !== undefined ? { title: f.title } : {}),
      ...(f.name !== undefined ? { name: f.name } : {}),
      ...(f.jurisdiction !== undefined ? { jurisdiction: f.jurisdiction } : {}),
      ...(f.amount !== undefined ? { amount: f.amount } : {}),
    });
    if (added) {
      includedFacts.push(f);
      addEdge(nid, `type:${typeId}`, 'ontology/type', 'instance', { source: f['ontology/source'] });
      addEdge(nid, `connector:${f['ontology/source']}`, 'ontology/source', 'provenance', { source: f['ontology/source'] });
    }
  }

  // Fact-to-fact join instance edges ONLY between facts already inside nodeMap, capped by boundEdges
  for (const j of joins) {
    if (edges.length >= boundEdges) { edgesTruncated = true; break; }
    const leftFacts = includedFacts.filter((f) => f['ontology/type'] === j.leftType);
    const rightByKey = new Map();
    for (const rf of includedFacts) {
      if (rf['ontology/type'] !== j.rightType) continue;
      const val = rf[j.rightKey];
      if (val !== undefined && val !== null) {
        const k = String(val);
        const list = rightByKey.get(k) ?? [];
        list.push(rf);
        rightByKey.set(k, list);
      }
    }
    for (const lf of leftFacts) {
      if (edges.length >= boundEdges) { edgesTruncated = true; break; }
      const val = lf[j.leftKey];
      if (val === undefined || val === null) continue;
      const matches = rightByKey.get(String(val)) ?? [];
      for (const rf of matches) {
        if (!addEdge(
          `fact:${j.leftType}:${lf.id}`,
          `fact:${j.rightType}:${rf.id}`,
          j.name,
          'join-instance',
          { leftKey: j.leftKey, rightKey: j.rightKey },
        )) {
          break;
        }
      }
    }
  }

  // Optional Layer 4: Standalone RDF quad subjects
  if (includeRdfSubjects) {
    const basePrefix = `${snapshot.baseIri}entity/`;
    const seenSubj = new Set();
    for (const q of snapshot.quads) {
      if (nodes.length >= boundNodes) break;
      const sv = q.subject.value;
      if (sv.startsWith(basePrefix) || seenSubj.has(sv)) continue;
      seenSubj.add(sv);
      addNode(`rdf:${sv}`, sv.split(/[#/:]/).filter(Boolean).slice(-1)[0] || sv, 'rdf-subject', {
        iri: sv,
        rdfType: q.subject.rdfType,
      });
    }
  }

  // Null-prototype accumulators (prototype-pollution safe) converted to clean plain objects
  const byConnectorMap = Object.create(null);
  const byObjectTypeMap = Object.create(null);
  const byJurisdictionMap = Object.create(null);
  for (const f of snapshot.facts) {
    const src = normalizeKeyword(f['ontology/source']) ?? 'unknown';
    const tp = normalizeKeyword(f['ontology/type']) ?? 'unknown';
    byConnectorMap[src] = (byConnectorMap[src] ?? 0) + 1;
    byObjectTypeMap[tp] = (byObjectTypeMap[tp] ?? 0) + 1;
    if (f.jurisdiction !== undefined && f.jurisdiction !== null) {
      const jur = normalizeKeyword(String(f.jurisdiction)) ?? String(f.jurisdiction);
      byJurisdictionMap[jur] = (byJurisdictionMap[jur] ?? 0) + 1;
    }
  }
  const toPlain = (nullProto) => Object.assign({}, nullProto);

  const layerCounts = { connector: 0, 'object-type': 0, fact: 0, 'rdf-subject': 0 };
  for (const n of nodes) layerCounts[n.layer] = (layerCounts[n.layer] ?? 0) + 1;

  const layers = [
    { id: 'connector', label: 'Connectors', order: 0, nodeCount: layerCounts.connector },
    { id: 'object-type', label: 'Object Types', order: 1, nodeCount: layerCounts['object-type'] },
    { id: 'fact', label: 'Facts (Provenance-Tagged)', order: 2, nodeCount: layerCounts.fact },
    ...(layerCounts['rdf-subject'] > 0
      ? [{ id: 'rdf-subject', label: 'RDF Subjects', order: 3, nodeCount: layerCounts['rdf-subject'] }]
      : []),
  ];

  const totalCandidates = snapshot.registry.objectTypes.length + snapshot.registry.connectors.length + snapshot.facts.length;
  const truncated = totalCandidates > nodes.length || edgesTruncated;
  return {
    schema: ONTOLOGY_GRAPH_SCHEMA,
    version: 1,
    basisCid: snapshot.basisCid,
    id: snapshot.id,
    stats: snapshot.stats,
    nodeCount: nodes.length,
    meta: {
      id: snapshot.id,
      snapshotSchema: snapshot.schema,
      stats: snapshot.stats,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      layerCount: layers.length,
      truncated,
      edgesTruncated,
    },
    layers,
    nodes,
    edges,
    joins,
    coverage: {
      byConnector: toPlain(byConnectorMap),
      byObjectType: toPlain(byObjectTypeMap),
      byJurisdiction: toPlain(byJurisdictionMap),
      totalJoins: joins.length,
      totalMatchedJoinRows: joins.reduce((s, j) => s + j.matchedRows, 0),
    },
    truncated,
    edgesTruncated,
  };
}

/**
 * Strip the outer self-referential `graphCid` envelope field (if present) so the canonical
 * DAG-CBOR payload hashes the exact `yataverse.ontology.graph/v1` body including array order
 * of `layers`, `nodes`, `edges`, and `joins`.
 */
function canonicalGraphPayload(graph) {
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
    throw new OntologyError('invalid-graph', 'graph must be an object');
  }
  const copy = Object.create(null);
  for (const [k, v] of Object.entries(graph)) {
    assertSafeKey(k, 'graph');
    if (k === 'graphCid') continue;
    copy[k] = v;
  }
  return copy;
}

/**
 * Encode a canonical `yataverse.ontology.graph/v1` object to canonical DAG-CBOR bytes and compute
 * its CIDv1 (`dag-cbor`, `sha2-256`).
 *
 * Canonical contract: array order of `layers`, `nodes`, `edges` (`e1, e2, ..., eN` sequential
 * numeric order), and `joins` is part of the hashed DAG-CBOR byte stream. Any reordering produces
 * different canonical bytes and a different `graphCid`.
 */
export function encodeOntologyGraphDagCbor(graph) {
  const bytes = encodeDagCbor(toDagCborSafe(canonicalGraphPayload(graph)));
  const cid = cidFor(bytes, CODEC_DAG_CBOR);
  return { cid, bytes };
}

/**
 * Verify a `yataverse.ontology.graph/v1` object against its declared `graphCid` (and/or caller
 * `expectedGraphCid`). Fails closed on missing CID, invalid CID shape/codec, schema mismatch,
 * or digest mismatch (including any array reordering such as `e1, e10, ...` vs `e1, e2, ...`).
 *
 * Distinguishes `graphVerification` (verified against canonical DAG-CBOR of the graph body) from
 * `basisVerification` (the underlying `basisCid` snapshot block closure is NOT verified here
 * unless the caller separately verified it via `verifyOntologySnapshot` and passes `basisVerified: true`).
 */
export function verifyOntologyGraphCid(graph, { expectedGraphCid = null, basisVerified = false } = {}) {
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
    throw new OntologyError('invalid-graph', 'graph must be an object');
  }
  if (graph.schema !== ONTOLOGY_GRAPH_SCHEMA || graph.version !== 1) {
    throw new OntologyError('invalid-graph-schema', String(graph.schema));
  }
  if (!Array.isArray(graph.layers) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !Array.isArray(graph.joins)) {
    throw new OntologyError('invalid-graph', 'graph requires layers, nodes, edges, and joins arrays');
  }
  const declaredCid = graph.graphCid ?? null;
  if (!declaredCid && !expectedGraphCid) {
    throw new OntologyError('missing-graph-cid', 'graphCid or expectedGraphCid is required for verification');
  }
  const checkCidShape = (c, label) => {
    const parsed = parseCid(c);
    if (!parsed || parsed.version !== 1 || parsed.codec !== CODEC_DAG_CBOR || parsed.hashCode !== SHA2_256) {
      throw new OntologyError('invalid-graph-cid', `${label}: ${String(c)}`);
    }
  };
  if (declaredCid) checkCidShape(declaredCid, 'graphCid');
  if (expectedGraphCid) checkCidShape(expectedGraphCid, 'expectedGraphCid');

  const { cid: computedCid, bytes } = encodeOntologyGraphDagCbor(graph);
  if (declaredCid && declaredCid !== computedCid) {
    throw new OntologyError('graph-cid-mismatch', `declared ${declaredCid} !== computed ${computedCid}`);
  }
  if (expectedGraphCid && expectedGraphCid !== computedCid) {
    throw new OntologyError('graph-cid-mismatch', `expected ${expectedGraphCid} !== computed ${computedCid}`);
  }
  return {
    verified: true,
    graphCidVerified: true,
    basisCidVerified: Boolean(basisVerified),
    verificationScope: basisVerified ? 'graph-and-basis' : 'graph-cid-only',
    graphCid: computedCid,
    basisCid: graph.basisCid ?? null,
    graphVerification: {
      status: 'verified',
      graphCid: computedCid,
      codec: 'dag-cbor',
      hash: 'sha2-256',
    },
    basisVerification: {
      status: basisVerified ? 'verified' : 'unverified-by-graph-check',
      basisCid: graph.basisCid ?? null,
      note: basisVerified
        ? 'Underlying ontology snapshot closure verified separately via verifyOntologySnapshot.'
        : 'verifyOntologyGraphCid verifies graphCid over the graph body only; the underlying basisCid snapshot is not verified by this check.',
    },
    bytes,
    graph,
  };
}

/**
 * Deterministic, standalone, XSS-safe SVG graph renderer for an OntologySnapshot or OntologyGraph.
 * Standalone SVGs omit interactive role="button" / tabindex attributes unless `interactive: true`
 * is explicitly passed by an interactive HTML host.
 * When passed an external `yataverse.ontology.graph/v1` carrying `graphCid` (or `expectedGraphCid`),
 * verifies `graphCid` via `verifyOntologyGraphCid` (fail-closed) before rendering.
 */
export function renderOntologySvg(snapshotOrGraph, { maxNodes = 64, interactive = false, expectedGraphCid = null } = {}) {
  let graph;
  if (snapshotOrGraph?.schema === ONTOLOGY_GRAPH_SCHEMA) {
    if (snapshotOrGraph.graphCid !== undefined || expectedGraphCid !== null) {
      verifyOntologyGraphCid(snapshotOrGraph, { expectedGraphCid });
    }
    graph = snapshotOrGraph;
  } else {
    graph = buildOntologyGraph(snapshotOrGraph, { maxNodes });
    if (expectedGraphCid !== null) {
      verifyOntologyGraphCid(graph, { expectedGraphCid });
    }
  }

  const cols = Object.assign(Object.create(null), { connector: 120, 'object-type': 420, fact: 740, 'rdf-subject': 1020 });
  const hasRdfLayer = graph.nodes.some((n) => n.layer === 'rdf-subject');
  const width = hasRdfLayer ? 1160 : 900;
  const rowsByLayer = Object.assign(Object.create(null), { connector: 0, 'object-type': 0, fact: 0, 'rdf-subject': 0 });
  const positions = new Map();

  for (const n of graph.nodes) {
    const layerKey = typeof n.layer === 'string' ? n.layer : '';
    const row = Object.hasOwn(rowsByLayer, layerKey) ? rowsByLayer[layerKey] : 0;
    rowsByLayer[layerKey] = row + 1;
    const x = Object.hasOwn(cols, layerKey) ? cols[layerKey] : 420;
    positions.set(n.id, { x, y: 74 + row * 68 });
  }

  const maxRows = Math.max(1, ...Object.values(rowsByLayer));
  const height = Math.max(240, 100 + maxRows * 68);

  const palette = Object.assign(Object.create(null), {
    connector: { bg: '#e8f4f8', stroke: '#1d6f8a' },
    'object-type': { bg: '#eef7ea', stroke: '#2f6f3e' },
    fact: { bg: '#f7f3e9', stroke: '#8a6220' },
    'rdf-subject': { bg: '#f3eefd', stroke: '#6d28d9' },
  });

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Ontology Graph for ${escapeXml(graph.basisCid)}" data-basis-cid="${escapeXml(graph.basisCid)}">`,
    '<defs><marker id="yv-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 1 L 10 5 L 0 9 z" fill="#5c6670"/></marker></defs>',
    `<rect x="0" y="0" width="${width}" height="${height}" fill="#fafbfc" rx="8"/>`,
  ];

  for (const layer of graph.layers) {
    const lx = (Object.hasOwn(cols, layer.id) ? cols[layer.id] : 420) - 90;
    parts.push(`<text x="${lx}" y="30" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12" font-weight="600" fill="#334155">${escapeXml(layer.label)} (${layer.nodeCount})</text>`);
  }

  for (const e of graph.edges) {
    const a = positions.get(e.from);
    const b = positions.get(e.to);
    if (!a || !b) continue;
    let x1 = a.x;
    let y1 = a.y;
    let x2 = b.x;
    let y2 = b.y;
    if (a.x < b.x) { x1 += 92; x2 -= 92; }
    else if (a.x > b.x) { x1 -= 92; x2 += 92; }
    else { y1 += a.y < b.y ? 20 : -20; y2 += a.y < b.y ? -20 : 20; }
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2 - 5;
    const isJoin = e.kind === 'join' || e.kind === 'join-instance';
    const stroke = isJoin ? '#2563eb' : '#64748b';
    const dash = isJoin ? ' stroke-dasharray="5,3"' : '';
    parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="1.5"${dash} marker-end="url(#yv-arrow)" data-edge-id="${escapeXml(e.id)}" data-edge-kind="${escapeXml(e.kind)}"/>`);
    parts.push(`<text x="${mx}" y="${my}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="10" fill="#475569" data-edge-id="${escapeXml(e.id)}">${escapeXml(e.label)}</text>`);
  }

  for (const n of graph.nodes) {
    const p = positions.get(n.id);
    const st = Object.hasOwn(palette, n.layer) ? palette[n.layer] : { bg: '#ffffff', stroke: '#334155' };
    const text = n.label.length > 24 ? `${n.label.slice(0, 21)}...` : n.label;
    const interactiveAttrs = interactive
      ? ` tabindex="0" role="button" aria-label="${escapeXml(n.label)}"`
      : '';
    parts.push(`<g class="yv-node"${interactiveAttrs} data-node-id="${escapeXml(n.id)}" data-node-kind="${escapeXml(n.kind)}" data-layer="${escapeXml(n.layer)}">`);
    parts.push(`<rect x="${p.x - 92}" y="${p.y - 20}" width="184" height="40" rx="6" fill="${st.bg}" stroke="${st.stroke}" stroke-width="1.5"/>`);
    parts.push(`<text x="${p.x}" y="${p.y + 4}" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12" fill="#0f172a">${escapeXml(text)}</text>`);
    parts.push('</g>');
  }

  parts.push('</svg>');
  return parts.join('\n');
}

/** Render the interactive, self-contained Semantic HTML5 Ontology Viewer. */
export function renderOntologyHtml(snapshot, {
  title,
  maxNodes = 64,
  activeLayers,
  apiBase = '/ontology/v1',
  sqlEndpoint = '/ontology/sql',
  sparqlEndpoint = '/ontology/sparql',
  viewerPath = '/ontology/viewer',
  graphEndpoint = '/ontology/graph',
  schema,
  inspection,
  isSeededDefault = false,
} = {}) {
  assertSafeEndpointPath(apiBase, 'apiBase');
  assertSafeEndpointPath(sqlEndpoint, 'sqlEndpoint');
  assertSafeEndpointPath(sparqlEndpoint, 'sparqlEndpoint');
  assertSafeEndpointPath(viewerPath, 'viewerPath');
  assertSafeEndpointPath(graphEndpoint, 'graphEndpoint');

  const graph = buildOntologyGraph(snapshot, { maxNodes, ...(activeLayers !== undefined ? { activeLayers } : {}) });
  const svg = renderOntologySvg(graph, { maxNodes, interactive: true });
  const safeTitle = title ?? `Yataverse Ontology Viewer — ${snapshot.id}`;
  const defaultSqlTable = snapshot.registry.objectTypes[0]?.id ?? 'ontology_facts';
  const defaultSql = `SELECT * FROM ${defaultSqlTable} LIMIT 25`;
  const defaultSparql = 'SELECT ?s ?p ?o WHERE { ?s ?p ?o . } LIMIT 25';
  const initialSelectedNodeId = graph.nodes[0]?.id ?? null;
  const opsList = schema?.operations ?? [];
  const resolvedActiveLayers = activeLayers === undefined || activeLayers === null
    ? graph.layers.map((l) => l.id)
    : [...activeLayers];
  const initialScreenState = {
    screenId: 'yataverse.ontology.viewer',
    status: 'ready',
    basisCid: snapshot.basisCid,
    activeTab: 'graph',
    activeLayers: resolvedActiveLayers,
    visibleNodeCount: graph.nodes.length,
    visibleEdgeCount: graph.edges.length,
    selectedNodeId: initialSelectedNodeId,
    ops: opsList.map((o) => o.operation),
  };
  const layerFilterControls = graph.layers.map((l) => {
    const checked = resolvedActiveLayers.includes(l.id) ? ' checked' : '';
    return `<label><input type="checkbox" data-layer-toggle="${escapeXml(l.id)}"${checked}> ${escapeXml(l.label)}</label>`;
  }).join(' ');

  const typeRows = snapshot.registry.objectTypes.map((t) =>
    `<tr><td><code>${escapeXml(t.id)}</code></td><td>${escapeXml(t.name)}</td><td><code>${escapeXml(Object.keys(t.attributes).join(', '))}</code></td></tr>`
  ).join('\n');

  const connectorRows = snapshot.registry.connectors.map((c) =>
    `<tr><td><code>${escapeXml(c.id)}</code></td><td>${escapeXml(c.name)}</td><td><code>${escapeXml(c.objectType)}</code></td><td>${escapeXml(c.status)}</td></tr>`
  ).join('\n');

  const joinRows = graph.joins.length
    ? graph.joins.map((j) =>
      `<tr><td><code>${escapeXml(j.name)}</code></td><td><code>${escapeXml(j.leftType)}.${escapeXml(j.leftKey)}</code></td><td><code>${escapeXml(j.rightType)}.${escapeXml(j.rightKey)}</code></td><td>${escapeXml(j.kind)}</td><td>${j.leftCount} / ${j.rightCount}</td><td>${j.matchedRows}</td><td>${Math.round(j.coverageRatio * 100)}%</td></tr>`
    ).join('\n')
    : '<tr><td colspan="7">No join mappings declared on this snapshot.</td></tr>';

  const tablesList = inspection?.tables ?? [...snapshot.tables.values()].map((t) => ({
    name: t.name,
    rowCount: t.rows.length,
    columns: t.rows[0] ? Object.keys(t.rows[0]) : [],
  }));
  const tableRows = tablesList.map((t) =>
    `<tr><td><code>${escapeXml(t.name)}</code></td><td>${t.rowCount}</td><td><code>${escapeXml(t.columns.join(', '))}</code></td></tr>`
  ).join('\n');

  const opRows = opsList.map((op) =>
    `<tr><td><code>${escapeXml(op.operation)}</code></td><td>${escapeXml(op.noun)}</td><td>${escapeXml(op.verb)}</td><td>${op.readOnly ? 'read-only' : 'write'}</td><td>${escapeXml(op.summary)}</td></tr>`
  ).join('\n');

  const graphUrl = isSeededDefault
    ? graphEndpoint
    : `${graphEndpoint}?cid=${encodeURIComponent(snapshot.basisCid)}`;
  const graphCborUrl = isSeededDefault
    ? `${graphEndpoint}?format=dag-cbor`
    : `${graphEndpoint}?cid=${encodeURIComponent(snapshot.basisCid)}&format=dag-cbor`;

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
    header, main { max-width: 1180px; margin: 0 auto; padding: 1rem 1.25rem; }
    header { border-bottom: 1px solid var(--yv-border); background: var(--yv-surface); }
    h1 { margin: 0 0 0.25rem 0; font-size: 1.4rem; }
    h2 { margin: 0 0 0.75rem 0; font-size: 1.1rem; }
    h3 { margin: 1rem 0 0.4rem 0; font-size: 0.98rem; }
    .yv-meta { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.84rem; color: var(--yv-muted); word-break: break-all; }
    .yv-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0.75rem; margin: 1rem 0; }
    .yv-card { background: var(--yv-surface); border: 1px solid var(--yv-border); border-radius: 8px; padding: 0.75rem 1rem; }
    .yv-card strong { display: block; font-size: 1.35rem; }
    .yv-split { display: grid; grid-template-columns: minmax(0, 2fr) minmax(260px, 1fr); gap: 1rem; align-items: start; }
    @media (max-width: 860px) { .yv-split { grid-template-columns: 1fr; } }
    section, aside { background: var(--yv-surface); border: 1px solid var(--yv-border); border-radius: 8px; padding: 1rem; margin: 1rem 0; }
    .yv-split section, .yv-split aside { margin: 0; }
    table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
    th, td { text-align: left; padding: 0.45rem 0.6rem; border-bottom: 1px solid var(--yv-border); vertical-align: top; }
    th { background: #f1f5f9; }
    textarea, input[type="text"] { width: 100%; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.88rem; padding: 0.5rem; border: 1px solid var(--yv-border); border-radius: 6px; }
    textarea { min-height: 5.5rem; }
    .yv-inline-form { display: flex; gap: 0.5rem; margin-top: 0.6rem; flex-wrap: wrap; }
    .yv-inline-form input[type="text"] { flex: 1 1 320px; }
    button { padding: 0.45rem 0.9rem; border: 1px solid var(--yv-accent); background: var(--yv-accent); color: #ffffff; border-radius: 6px; cursor: pointer; font-weight: 600; }
    .yv-tablist { display: flex; gap: 0.4rem; flex-wrap: wrap; margin: 0.75rem 0; border-bottom: 1px solid var(--yv-border); padding-bottom: 0.5rem; }
    .yv-tablist button[role="tab"] { background: var(--yv-surface); color: var(--yv-ink); border-color: var(--yv-border); }
    .yv-tablist button[role="tab"][aria-selected="true"] { background: var(--yv-accent); color: #ffffff; border-color: var(--yv-accent); }
    pre { background: #0f172a; color: #e2e8f0; padding: 0.75rem; border-radius: 6px; overflow: auto; font-size: 0.8rem; max-height: 320px; }
    .yv-graph { overflow-x: auto; }
    .yv-node { cursor: pointer; }
    .yv-node:hover rect, .yv-node[data-selected="true"] rect { stroke-width: 3; }
    nav { display: flex; gap: 1rem; flex-wrap: wrap; margin-top: 0.5rem; font-size: 0.9rem; }
    nav a { color: var(--yv-accent); text-decoration: none; }
    .yv-console-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 1rem; }
    .yv-result-table { margin-top: 0.6rem; overflow-x: auto; }
  </style>
</head>
<body data-basis-cid="${escapeXml(snapshot.basisCid)}" data-schema="${escapeXml(snapshot.schema)}" data-screen-id="yataverse.ontology.viewer" data-status="ready" data-active-tab="graph" data-active-layers="${escapeXml(resolvedActiveLayers.join(','))}" data-selected-node-id="${escapeXml(initialSelectedNodeId ?? '')}">
  <header>
    <h1>${escapeXml(safeTitle)}</h1>
    <div class="yv-meta">basisCid: <code>${escapeXml(snapshot.basisCid)}</code> · schema: <code>${escapeXml(snapshot.schema)}</code> · read-only${isSeededDefault ? ' · seeded kotoba.ontology demo' : ' · verified IPLD block closure'}</div>
    <nav aria-label="Viewer navigation">
      <a href="/">Home</a>
      <a href="${escapeXml(graphUrl)}">Graph JSON</a>
      <a href="${escapeXml(graphCborUrl)}">Graph DAG-CBOR</a>
      <a href="${escapeXml(apiBase)}/schema">Semantic Schema</a>
    </nav>
    <form class="yv-inline-form" method="get" action="${escapeXml(viewerPath)}" data-operation="ontology.view">
      <label for="yv-cid-input" style="position:absolute;width:1px;height:1px;overflow:hidden;">Load Ontology CID</label>
      <input id="yv-cid-input" name="cid" type="text" placeholder="bafyrei... (load a verified DAG-CBOR ontology snapshot CID from Yataverse)" value="${isSeededDefault ? '' : escapeXml(snapshot.basisCid)}">
      <button type="submit">Inspect CID</button>
    </form>
  </header>

  <main>
    <div class="yv-grid" aria-label="Snapshot summary">
      <article class="yv-card"><span>Object Types</span><strong>${snapshot.stats.objectTypes}</strong></article>
      <article class="yv-card"><span>Connectors</span><strong>${snapshot.stats.connectors}</strong></article>
      <article class="yv-card"><span>Facts</span><strong>${snapshot.stats.facts}</strong></article>
      <article class="yv-card"><span>RDF Quads</span><strong>${snapshot.stats.quads}</strong></article>
      <article class="yv-card"><span>Join Mappings</span><strong>${snapshot.stats.joins}</strong></article>
    </div>

    <div class="yv-tablist" role="tablist" aria-label="Ontology viewer panels" id="yv-tablist">
      <button type="button" role="tab" id="yv-tab-graph" aria-selected="true" aria-controls="yv-panel-graph" tabindex="0" data-tab="graph">Graph &amp; Inspector</button>
      <button type="button" role="tab" id="yv-tab-consoles" aria-selected="false" aria-controls="yv-panel-consoles" tabindex="-1" data-tab="consoles">SQL &amp; SPARQL Console</button>
      <button type="button" role="tab" id="yv-tab-joins" aria-selected="false" aria-controls="yv-panel-joins" tabindex="-1" data-tab="joins">External Joins</button>
      <button type="button" role="tab" id="yv-tab-registry" aria-selected="false" aria-controls="yv-panel-registry" tabindex="-1" data-tab="registry">Registry &amp; Tables</button>
      <button type="button" role="tab" id="yv-tab-operations" aria-selected="false" aria-controls="yv-panel-operations" tabindex="-1" data-tab="operations">Semantic Operations</button>
    </div>

    <div role="tabpanel" id="yv-panel-graph" aria-labelledby="yv-tab-graph" data-tab-panel="graph">
      <div class="yv-split" id="graph">
        <section aria-labelledby="graph-heading" data-operation="ontology.graph">
          <h2 id="graph-heading">Ontology Graph (Click a node to inspect)</h2>
          <fieldset id="yv-layer-filters" aria-label="Layer filters" style="border:1px solid var(--yv-border);border-radius:6px;padding:0.4rem 0.6rem;margin-bottom:0.6rem;display:flex;gap:0.75rem;flex-wrap:wrap;align-items:center;">
            <legend style="font-size:0.82rem;color:var(--yv-muted);">Layers</legend>
            ${layerFilterControls}
            <button type="button" id="yv-layers-all">All</button>
            <button type="button" id="yv-layers-clear">Clear</button>
          </fieldset>
          <div class="yv-graph">${svg}</div>
        </section>
        <aside aria-labelledby="inspector-heading" id="yv-node-inspector" data-operation="ontology.inspect">
          <h2 id="inspector-heading">Node Detail Inspector</h2>
          <p class="yv-meta" id="yv-inspector-summary">Select any connector, object type, or fact node in the graph.</p>
          <pre id="yv-inspector-json">{}</pre>
        </aside>
      </div>
    </div>

    <div role="tabpanel" id="yv-panel-consoles" aria-labelledby="yv-tab-consoles" data-tab-panel="consoles" hidden>
      <div class="yv-console-grid" id="consoles">
        <section aria-labelledby="sql-heading">
          <h2 id="sql-heading">SQL Query Console (Read-Only)</h2>
          <form data-operation="ontology.query_sql" id="yv-sql-form">
            <label for="yv-sql-input">SQL SELECT (pinned to basisCid)</label>
            <textarea id="yv-sql-input" name="query">${escapeXml(defaultSql)}</textarea>
            <button type="submit">Run ontology.query_sql</button>
          </form>
          <div class="yv-result-table" id="yv-sql-table"></div>
          <pre id="yv-sql-out" aria-live="polite">Submit a SQL SELECT query against ${escapeXml(snapshot.basisCid)}.</pre>
        </section>

        <section aria-labelledby="sparql-heading">
          <h2 id="sparql-heading">SPARQL Query Console (Read-Only)</h2>
          <form data-operation="ontology.query_sparql" id="yv-sparql-form">
            <label for="yv-sparql-input">SPARQL (SELECT / ASK / CONSTRUCT / DESCRIBE)</label>
            <textarea id="yv-sparql-input" name="query">${escapeXml(defaultSparql)}</textarea>
            <button type="submit">Run ontology.query_sparql</button>
          </form>
          <div class="yv-result-table" id="yv-sparql-table"></div>
          <pre id="yv-sparql-out" aria-live="polite">Submit a SPARQL query against ${escapeXml(snapshot.basisCid)}.</pre>
        </section>
      </div>
    </div>

    <div role="tabpanel" id="yv-panel-joins" aria-labelledby="yv-tab-joins" data-tab-panel="joins" hidden>
      <section id="joins" aria-labelledby="joins-heading">
        <h2 id="joins-heading">External Join Coverage</h2>
        <table>
          <thead><tr><th>Join</th><th>Left</th><th>Right</th><th>Kind</th><th>Left / Right Rows</th><th>Matched</th><th>Coverage</th></tr></thead>
          <tbody>${joinRows}</tbody>
        </table>
      </section>
    </div>

    <div role="tabpanel" id="yv-panel-registry" aria-labelledby="yv-tab-registry" data-tab-panel="registry" hidden>
      <section id="registry" aria-labelledby="registry-heading" data-operation="ontology.inspect">
        <h2 id="registry-heading">Vocabulary Registry &amp; Relational Tables</h2>
        <h3>Object Types</h3>
        <table><thead><tr><th>ID</th><th>Name</th><th>Required Attributes</th></tr></thead><tbody>${typeRows}</tbody></table>
        <h3>Registered Connectors</h3>
        <table><thead><tr><th>ID</th><th>Name</th><th>Object Type</th><th>Status</th></tr></thead><tbody>${connectorRows}</tbody></table>
        <h3>Projected Tables</h3>
        <table><thead><tr><th>Table</th><th>Rows</th><th>Columns</th></tr></thead><tbody>${tableRows}</tbody></table>
      </section>
    </div>

    <div role="tabpanel" id="yv-panel-operations" aria-labelledby="yv-tab-operations" data-tab-panel="operations" hidden>
      <section id="operations" aria-labelledby="ops-heading">
        <h2 id="ops-heading">Semantic UI Operations (noun.verb Contract)</h2>
        <table><thead><tr><th>Operation</th><th>Noun</th><th>Verb</th><th>Mode</th><th>Summary</th></tr></thead><tbody>${opRows}</tbody></table>
      </section>
    </div>
  </main>

  <script type="application/json" id="yataverse-screen-state">${safeJsonScript(initialScreenState)}</script>
  <script type="application/json" id="yataverse-semantic-schema">${safeJsonScript({
    basisCid: snapshot.basisCid,
    isSeededDefault,
    apiBase,
    sqlEndpoint,
    sparqlEndpoint,
    graphEndpoint,
    schema,
    graph,
  })}</script>
  <script>${VIEWER_CLIENT_SCRIPT}</script>
</body>
</html>`;
}

/** Render the Yataverse root landing page (`GET /`) — zero executable script tags. */
export function renderYataverseHomeHtml(defaultSnapshot, { schema } = {}) {
  const graph = buildOntologyGraph(defaultSnapshot, { maxNodes: 24 });
  const previewSvg = renderOntologySvg(graph, { maxNodes: 24, interactive: false });
  const ops = schema?.operations ?? [];
  const homeScreenState = {
    screenId: 'yataverse.home',
    status: 'ready',
    basisCid: defaultSnapshot.basisCid,
    activeTab: null,
    selectedNodeId: null,
    ops: ops.map((o) => o.operation),
  };

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Yataverse — Verified Bytes Plane &amp; IPLD Ontology Viewer</title>
  <style>
    :root { --yv-bg: #f8fafc; --yv-surface: #ffffff; --yv-border: #cbd5e1; --yv-ink: #0f172a; --yv-muted: #475569; --yv-accent: #1d4ed8; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: var(--yv-bg); color: var(--yv-ink); line-height: 1.55; }
    header, main { max-width: 1080px; margin: 0 auto; padding: 1.25rem; }
    header { background: var(--yv-surface); border-bottom: 1px solid var(--yv-border); }
    h1 { margin: 0 0 0.3rem 0; font-size: 1.55rem; }
    p.lead { margin: 0; color: var(--yv-muted); }
    section { background: var(--yv-surface); border: 1px solid var(--yv-border); border-radius: 8px; padding: 1rem 1.25rem; margin: 1rem 0; }
    .yv-actions { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-top: 0.9rem; }
    .yv-btn { display: inline-block; padding: 0.5rem 1rem; border-radius: 6px; text-decoration: none; font-weight: 600; border: 1px solid var(--yv-accent); background: var(--yv-accent); color: #ffffff; }
    .yv-btn-secondary { background: #ffffff; color: var(--yv-accent); }
    form.yv-inline { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.75rem; }
    input[type="text"] { flex: 1 1 320px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9rem; padding: 0.5rem; border: 1px solid var(--yv-border); border-radius: 6px; }
    button { padding: 0.5rem 1rem; border-radius: 6px; border: 1px solid var(--yv-accent); background: var(--yv-accent); color: #ffffff; font-weight: 600; cursor: pointer; }
    table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    th, td { text-align: left; padding: 0.45rem 0.6rem; border-bottom: 1px solid var(--yv-border); }
    th { background: #f1f5f9; }
    .yv-graph { overflow-x: auto; }
  </style>
</head>
<body data-service="yataverse-bytes" data-default-basis-cid="${escapeXml(defaultSnapshot.basisCid)}" data-screen-id="yataverse.home" data-status="ready">
  <header>
    <h1>Yataverse</h1>
    <p class="lead">Verified content-addressed IPLD bytes plane (CIDv1 / DAG-CBOR / CARv1-v2 / signed storage receipts) and read-only Ontology SQL/SPARQL Viewer.</p>
    <div class="yv-actions">
      <a class="yv-btn" href="/ontology/viewer" data-operation="ontology.view">Open Interactive Ontology Viewer</a>
      <a class="yv-btn yv-btn-secondary" href="/ontology/graph" data-operation="ontology.graph">Canonical Graph JSON</a>
      <a class="yv-btn yv-btn-secondary" href="/ontology/v1/schema">Semantic UI Schema</a>
      <a class="yv-btn yv-btn-secondary" href="/health">Health</a>
    </div>
    <form class="yv-inline" method="get" action="/ontology/viewer" data-operation="ontology.view">
      <label for="yv-home-cid" style="position:absolute;width:1px;height:1px;overflow:hidden;">Ontology Snapshot CID</label>
      <input id="yv-home-cid" name="cid" type="text" placeholder="bafyrei... (enter a stored DAG-CBOR ontology snapshot CID)">
      <button type="submit">Visualize CID</button>
    </form>
  </header>

  <main>
    <section aria-labelledby="preview-heading">
      <h2 id="preview-heading">Seeded Ontology Preview (<code>${escapeXml(defaultSnapshot.id)}</code>)</h2>
      <div class="yv-graph">${previewSvg}</div>
    </section>

    <section aria-labelledby="routes-heading">
      <h2 id="routes-heading">Public Endpoints</h2>
      <table>
        <thead><tr><th>Route</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td><code>GET /ontology</code>, <code>GET /ontology/viewer[?cid=...]</code></td><td>Interactive Ontology Viewer HTML (SVG graph, Node Inspector, SQL/SPARQL consoles, Join coverage)</td></tr>
          <tr><td><code>GET /ontology/graph[?cid=...&amp;format=json|dag-cbor]</code></td><td>Canonical layered graph model (JSON or canonical DAG-CBOR with CIDv1 ETag)</td></tr>
          <tr><td><code>POST /ontology/sql</code></td><td>Bounded, read-only, basis-pinned SQL SELECT engine (<code>ontology.query_sql</code>)</td></tr>
          <tr><td><code>POST /ontology/sparql</code></td><td>Bounded, read-only, basis-pinned SPARQL &amp; EDN algebra engine (<code>ontology.query_sparql</code>)</td></tr>
          <tr><td><code>GET /ontology/v1/schema</code></td><td>Machine-readable Semantic UI <code>noun.verb</code> catalog (${ops.length} operations)</td></tr>
          <tr><td><code>GET|PUT /ipfs/&lt;cid&gt;</code>, <code>POST /ipfs/</code></td><td>Verified raw/DAG-CBOR/UnixFS blocks and CARv1/CARv2 import with signed storage receipts</td></tr>
          <tr><td><code>GET /.well-known/yataverse-receipt-keys.json</code></td><td>Published Ed25519 receipt verification keys</td></tr>
        </tbody>
      </table>
    </section>
  </main>

  <script type="application/json" id="yataverse-screen-state">${safeJsonScript(homeScreenState)}</script>
  <script type="application/json" id="yataverse-semantic-schema">${safeJsonScript({ service: 'yataverse-bytes', defaultBasisCid: defaultSnapshot.basisCid, schema })}</script>
</body>
</html>`;
}
