# IPLD Ontology, SQL, SPARQL & Semantic Viewer

Yataverse provides pure, read-only, basis-pinned ontology storage, querying, and inspection over canonical DAG-CBOR IPLD blocks (`CIDv1`, `sha2-256`, tag-42 links) and CARv1 archives.

## 1. IPLD DAG-CBOR Snapshot Structure (`src/ontology.mjs`)

Every ontology snapshot is stored as a content-addressed 5-block DAG-CBOR graph:

- **Root (`yataverse.ontology.snapshot/v1`)**: pins `id`, `baseIri`, `stats`, optional `parentBasis`, and tag-42 CID links to:
  - `registry` (`yataverse.ontology.registry/v1`): object types and connectors, seeded with `kotoba.ontology` (`tender`) and `kotoba.ontology.connector` (`jp.kkj`, `jp.geps`).
  - `facts` (`yataverse.ontology.facts/v1`): normalized facts carrying `ontology/type` and `ontology/source` provenance from registered connectors.
  - `quads` (`yataverse.ontology.quads/v1`): deduplicated, deterministically sorted RDF quads projected from facts, explicit quads, and JSON-LD.
  - `joins` (`yataverse.ontology.joins/v1`): declared relational join mappings between object types.

### Fail-Closed Invariants

- **Provenance & Conformance**: `tagFact` and `buildOntologySnapshot` refuse unregistered connectors (`unregistered-connector`) and facts missing required object-type attributes (`fact-does-not-conform`).
- **No Remote JSON-LD `@context` Fetch**: `ingestJsonLd` never fetches remote `@context` or `@import` URLs over the network (`remote-context-refused`). Only inline contexts or caller-supplied `pinnedContexts` (optionally CID-verified) are accepted.
- **Visibility Predicate**: `scanQuads(snapshot, pattern, visible)` requires an explicit `visible(quad)` function (`visibility-predicate-required`), matching `datalog.query`. High-level SQL/SPARQL execution also supports declarative `jurisdiction`, `allowedSources`, and custom `visible` predicates.
- **Canonical DAG-CBOR**: All blocks pass `checkWritableBlock` (`CIDv1` `dag-cbor` `sha2-256`, canonical key ordering, complete closure, no unreachable stray blocks). Non-integer finite numbers use the versioned typed wrapper `{$awaiType: "decimal", value: "..."}` so strict DAG-CBOR integer guarantees stay intact.

## 2. Bounded Read-Only SQL (`src/ontology-sql.mjs`)

- **Supported**: `SELECT [DISTINCT]`, `FROM`, `INNER JOIN` / `LEFT [OUTER] JOIN ... ON`, `WHERE` (`=`, `!=`, `<>`, `<`, `<=`, `>`, `>=`, `AND`, `OR`, `NOT`, `IN`, `BETWEEN`, `LIKE`, `IS [NOT] NULL`), `GROUP BY`, `HAVING`, `ORDER BY [ASC|DESC]`, `LIMIT`, `OFFSET`, aggregates `COUNT`/`SUM`/`AVG`/`MIN`/`MAX`, and allowlisted scalar helpers (`LOWER`, `UPPER`, `LENGTH`, `COALESCE`).
- **Refused (Fail-Closed)**: `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `TRUNCATE`, `PRAGMA`, `SELECT ... INTO`, stacked statements, `WITH`, `UNION`, subqueries, window functions, arbitrary unallowlisted functions, `basisCid` mismatch, and scans/results exceeding `maxScanRows` / `maxResultRows` / `maxOutputBytes`.

## 3. Bounded Read-Only SPARQL & EDN Algebra (`src/ontology-sparql.mjs`)

- **Supported**: `PREFIX`, `BASE`, `SELECT [DISTINCT]`, `ASK`, `CONSTRUCT`, `DESCRIBE`, BGP triple joins (`a`, `;`, `,`), `OPTIONAL`, `UNION`, `GRAPH`, `FILTER` (comparisons, boolean ops, `BOUND`, `ISIRI`, `ISLITERAL`, `ISBLANK`, `STR`, `LANG`, `DATATYPE`, `CONTAINS`, `STRSTARTS`, `STRENDS`, `LCASE`, `UCASE`, `STRLEN`, bounded `REGEX`), `GROUP BY`, aggregates (`COUNT`/`SUM`/`AVG`/`MIN`/`MAX`), `ORDER BY [ASC|DESC]`, `LIMIT`, `OFFSET`.
- **EDN / JSON Algebra Bridge**: `algebraToEdn` and `ednToAlgebra` interoperate with `kotoba.sparql` (`:sparql/op :bgp | :filter | :join | :union | :optional | :group | :project | :distinct | :order-by | :slice`).
- **Refused (Fail-Closed)**: `SERVICE`, `FROM` / `FROM NAMED`, SPARQL Update verbs (`INSERT`, `DELETE`, `LOAD`, `CLEAR`, `DROP`, `CREATE`, `ADD`, `MOVE`, `COPY`), unsupported clauses (`BIND`, `VALUES`, `MINUS`, nested `SELECT`), unallowlisted filter functions, ReDoS-prone nested quantifiers, `basisCid` mismatch, and `maxScanSteps` / `maxSolutions` / `maxOutputBytes` overflows.

## 4. Reusable Visualization Library (`src/ontology-viz.mjs`) & Semantic UI (`noun.verb`) Viewer

Visualization logic is factored into a standalone, zero-dependency ESM module (`src/ontology-viz.mjs`) that constructs a canonical layered graph model (`yataverse.ontology.graph/v1` with `nodes`, `edges`, `layers`, `joins`, and `coverage`), encodes it to canonical DAG-CBOR (`encodeOntologyGraphDagCbor`), and renders standalone SVG and interactive Semantic HTML5 viewers (SVG graph, clickable node detail inspector, SQL/SPARQL consoles, and external join coverage table).

All viewer and API actions follow the `noun.verb` contract with machine-readable JSON Schemas (`src/ontology-viewer.mjs`):

| Operation | Mode | Description |
|---|---|---|
| `ontology.graph` | read-only | Project snapshot into canonical layered graph (`nodes/edges/layers/joins/coverage`) + DAG-CBOR `graphCid` |
| `ontology.build` | read-only | Build & verify canonical DAG-CBOR snapshot + CARv1 |
| `ontology.verify` | read-only | Verify CARv1/CARv2 snapshot CIDs, closure, and provenance |
| `ontology.inspect` | read-only | Inspect object types, connectors, tables, joins, and block CIDs |
| `ontology.query_sql` | read-only | Execute bounded SQL SELECT against pinned `basisCid` |
| `ontology.query_sparql` | read-only | Execute bounded SPARQL or EDN algebra against pinned `basisCid` |
| `ontology.view` | read-only | Render Semantic UI viewModel JSON, SVG graph, and HTML5 viewer |

### CLI

```sh
yataverse ontology schema
yataverse ontology build spec.json -o snapshot.car
yataverse ontology verify snapshot.car --basis bafyrei...
yataverse ontology inspect snapshot.car
yataverse ontology graph snapshot.car --format json
yataverse ontology graph snapshot.car --format dag-cbor -o graph.cbor
yataverse ontology sql snapshot.car --query "SELECT id, status FROM tender ORDER BY id"
yataverse ontology sparql snapshot.car --query "SELECT ?s ?p ?o WHERE { ?s ?p ?o . } LIMIT 10"
yataverse ontology view snapshot.car --format html -o viewer.html
```

### MCP Tools

- `yataverse_ontology_schema`
- `yataverse_ontology_graph`
- `yataverse_ontology_build`
- `yataverse_ontology_verify`
- `yataverse_ontology_inspect`
- `yataverse_ontology_query_sql`
- `yataverse_ontology_query_sparql`
- `yataverse_ontology_view`

### Worker HTTP Routes (`https://yataverse.com/`)

Snapshots are stored with existing verified block/CAR routes (`POST /ipfs/` with storage receipts) and visualized/queried read-only via:

- `GET /` — Yataverse landing page + immediate Ontology Viewer entry (with `?cid=<bafy...>`, loads & renders that verified DAG-CBOR snapshot)
- `GET /ontology`, `GET /ontology/viewer[?cid=<bafy...>&format=html|svg|json]` — Interactive Ontology Viewer (SVG graph, Node Detail Inspector, SQL/SPARQL console, external join coverage)
- `GET /ontology/graph[?cid=<bafy...>&format=json|dag-cbor]` — Canonical layered graph model as JSON or canonical DAG-CBOR (`yataverse-graph-cid` header & CIDv1 ETag)
- `POST /ontology/sql` — Bounded read-only SQL SELECT (`{ query, cid|basisCid|carBase64 }`)
- `POST /ontology/sparql` — Bounded read-only SPARQL / EDN algebra (`{ query|algebraEdn|algebra, cid|basisCid|carBase64 }`)
- `GET /ontology/v1/schema`
- `GET /ontology/v1/inspect/<basisCid>`
- `GET /ontology/v1/view/<basisCid>?format=html|svg|json`
- `POST /ontology/v1/ops/<noun.verb>` (JSON body with `{ basisCid, ... }` or `{ carBase64, ... }`)
