# BSS Knowledge Base — Implementation Plan

**Status:** Draft for review · **Date:** 2026-10-10 · **Owner:** Automation module
**Related:** [BSS Automation Blueprint](https://claude.ai/artifact/N7d43J3Ue6BvkRvD1JkH5F)

This plan moves the folder-based Automation KB and Journey KB (`knowledge_base/`) into a **new, dedicated PostgreSQL database `bss_kb`** on the same server as the Squad KB. It merges them with a taxonomy-scoped RAG into one Knowledge Base.

---

## 1. Decisions taken

| # | Decision | Reason |
|---|---|---|
| D1 | **New database `bss_kb` on the existing Postgres server.** The Squad KB database is not touched. | Strongest isolation available without a new server: separate backups, roles, connection limits and restore. |
| D2 | **One KB, four layers** (Domain, Application, Knowledge, Governance), all joined by a **taxonomy node id**. | Facts, business intent and retrievable prose live together but are stored differently. |
| D3 | **Taxonomy:** Application → Segment → Product Group → Product → Request → Sub-Request, stored as `ltree`. | Coverage, retrieval scope and E2E checkpoints are all keyed by this path. |
| D4 | **Exact facts are never embedded.** Locators, endpoints, steps and checkpoints are rows looked up by key. | Similarity search on exact facts produces wrong locators. |
| D5 | **RAG holds prose plus summary cards.** That means approved document chunks and one card per flow, journey or contract. | Cards make structured records findable by meaning without embedding the records. |
| D6 | **Nothing reaches retrieval unapproved.** Uploads, crawls, extractions and heals arrive as change sets; approval publishes them. | It is a permanent KB. The Squad KB's push-on-upload is not repeated. |
| D7 | **The folder is migrated, not abandoned.** It goes behind a repository interface, is shadow-read, cut over by flag, then frozen and replaced by a nightly export. | About 15 modules and ~58 file I/O sites read or write the folder today. |
| D8 | **The app database stays SQLite for now.** Test cases and runs refer to KB records by string id. | Moving the app database is a separate project. Nothing here needs cross-database joins. |
| D9 | **Fail loudly.** If the KB is unreachable, generation and compilation stop with a clear error. | Today a missing folder silently produces ungrounded output. |

## 2. Scope

**In scope:**
- Provisioning the `bss_kb` database
- Schema and migrations
- Repository seam
- Importer and exporter
- Shadow reads and cutover
- Taxonomy and request contracts (data only)
- Document ingestion with approval
- Chunks and cards
- Taxonomy-scoped retrieval (`kb.context`)
- Health checks
- KB page changes needed to read and write the database

**Out of scope (later phases of the Blueprint):**
- The MCP validation server and checkpoint execution. Checkpoints are only stored here.
- Channel adapters
- Moving the app database off SQLite
- Squad KB changes of any kind

---

## 3. Topology

```
Postgres server (existing)
├── <squad database>          ← unchanged; SQUAD_KB_DATABASE_URL
└── bss_kb                    ← NEW; BSS_KB_DATABASE_URL
    └── schema kb             ← all tables below

Backend container
├── SQLite admin.db           ← app data; test cases gain taxonomy_node_id (string)
├── knowledge_base/ (mount)   ← read until cutover (M4), then frozen (M5)
└── storage/kb_documents/     ← original uploaded files (PDF/DOCX/XLSX); rows hold path + sha256
```

Original files are not stored as `bytea`. The database holds metadata, extracted text and chunks, and the files stay on the storage volume, the same way run evidence is stored today.

---

## 4. Database provisioning (DBA runbook)

Run as a superuser, or as a role with `CREATEDB` and `CREATEROLE`. **The extensions step is the one that needs admin rights.**

### 4.1 Pre-checks

```sql
SELECT version();                                   -- PostgreSQL 15+ preferred
SELECT name, default_version, installed_version
  FROM pg_available_extensions
 WHERE name IN ('vector','vectorscale','ltree','pg_trgm');

-- Can a non-superuser database owner install it? (trusted = true means yes)
SELECT name, version, trusted, superuser
  FROM pg_available_extension_versions
 WHERE name IN ('vector','vectorscale','ltree','pg_trgm');
```

`ltree` and `pg_trgm` are trusted extensions on PG13+, so the database owner can create them. `vector` and `vectorscale` usually need a superuser. They must be **the same versions the Squad database uses**, so that index behaviour is identical.

### 4.2 Roles and database

```sql
-- Owner: runs migrations only. App: read/write at runtime. RO: reporting and exports.
CREATE ROLE bss_kb_owner LOGIN PASSWORD '<vault>';
CREATE ROLE bss_kb_app   LOGIN PASSWORD '<vault>' CONNECTION LIMIT 20;
CREATE ROLE bss_kb_ro    LOGIN PASSWORD '<vault>' CONNECTION LIMIT 5;

CREATE DATABASE bss_kb OWNER bss_kb_owner ENCODING 'UTF8' TEMPLATE template0;
REVOKE CONNECT ON DATABASE bss_kb FROM PUBLIC;
GRANT  CONNECT ON DATABASE bss_kb TO bss_kb_app, bss_kb_ro;

\c bss_kb
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS vectorscale;   -- DiskANN index, same as Squad KB
CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS pg_trgm;       -- fuzzy label / element-name matching

CREATE SCHEMA kb AUTHORIZATION bss_kb_owner;
ALTER ROLE bss_kb_app SET search_path = kb, public;
ALTER ROLE bss_kb_ro  SET search_path = kb, public;
ALTER ROLE bss_kb_app SET statement_timeout = '30s';
GRANT USAGE ON SCHEMA kb TO bss_kb_app, bss_kb_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE bss_kb_owner IN SCHEMA kb
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bss_kb_app;
ALTER DEFAULT PRIVILEGES FOR ROLE bss_kb_owner IN SCHEMA kb
  GRANT USAGE, SELECT ON SEQUENCES TO bss_kb_app;
ALTER DEFAULT PRIVILEGES FOR ROLE bss_kb_owner IN SCHEMA kb
  GRANT SELECT ON TABLES TO bss_kb_ro;
```

The app role cannot run DDL, so a runtime bug cannot drop or alter a table.

### 4.3 Access, backup and capacity

- `pg_hba.conf`: allow `bss_kb_*` only from the backend host.
- **Backups:** nightly `pg_dump -Fc -d bss_kb` on its own schedule and retention, separate from Squad. Run a **restore drill** before cutover (M4 gate).
- **Index builds:** DiskANN builds on `chunk`/`card` compete with Squad queries for CPU and IO. Run bulk re-embeds off-hours, and set `maintenance_work_mem` per session for the build.
- **Sizing:** the current folder is 6.2 MB (37 files). A full BSS document set is expected in the tens of thousands of chunks. Revisit a dedicated instance if the database passes ~1M chunks or Squad latency regresses.

---

## 5. Configuration

New settings in `app/config.py`. None of them are on the runner allowlist in `env_policy.py`, so generated scripts never see them.

| Setting | Default | Notes |
|---|---|---|
| `BSS_KB_DATABASE_URL` | `""` | `postgresql://bss_kb_app:…@host/bss_kb`. Secret. |
| `BSS_KB_MIGRATIONS_URL` | `""` | Owner role. Used only by the migration command, never by the app. |
| `KB_BACKEND` | `files` | `files` → `shadow` → `postgres`. One-line rollback. |
| `BSS_KB_EMBEDDING_BASE_URL` / `_API_KEY` / `_MODEL` | Squad values | Separate, so the two stores can diverge later. |
| `BSS_KB_EMBEDDING_DIMENSIONS` | `1024` | Locked in `kb.meta`. A mismatch refuses to start. |
| `BSS_KB_DOCUMENT_STORAGE` | `storage/kb_documents` | Original uploads. |
| `BSS_KB_POOL_SIZE` | `5` | psycopg pool. |

---

## 6. Data model (schema `kb`)

Migrations use a **second Alembic environment** (`alembic_kb/`, its own `alembic_version` table) so they never mix with the SQLite migrations.

### 6.1 Domain layer: what the business promises

```sql
CREATE TABLE meta (key text PRIMARY KEY, value jsonb NOT NULL);
-- rows: embedding_model, embedding_dimensions, schema_version

CREATE TABLE taxonomy_node (
  id          text PRIMARY KEY,                 -- 'SMB.MOB_POST.BFP_LOCAL_110.CHANGE_PLAN.DOWNGRADE'
  path        ltree NOT NULL UNIQUE,
  level       text NOT NULL CHECK (level IN
              ('application','segment','product_group','product','request','sub_request','common')),
  title       text NOT NULL,
  parent_id   text REFERENCES taxonomy_node(id),
  app_key     text,                             -- set on application-level nodes
  sort_order  int  NOT NULL DEFAULT 0,
  status      text NOT NULL DEFAULT 'active',   -- active | draft | retired
  attributes  jsonb NOT NULL DEFAULT '{}',      -- catalogue ids (TMF620), aliases
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX taxonomy_path_gist ON taxonomy_node USING gist (path);

CREATE TABLE request_contract (                 -- one per request / sub_request node
  node_id      text PRIMARY KEY REFERENCES taxonomy_node(id),
  channels     text[] NOT NULL DEFAULT '{}',    -- web_selfcare, mobile_app, retail_pos, ...
  personas     text[] NOT NULL DEFAULT '{}',
  data_profile text,
  preconditions jsonb NOT NULL DEFAULT '{}',
  checkpoints  jsonb NOT NULL DEFAULT '[]',     -- [{tool, expect, within}] (used by MCP layer later)
  evidence     text[] NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'draft',
  version      int  NOT NULL DEFAULT 1
);

CREATE TABLE business_rule (id text PRIMARY KEY, app_key text, title text NOT NULL,
  body text NOT NULL, source_ref text, attributes jsonb NOT NULL DEFAULT '{}');
CREATE TABLE persona      (id text PRIMARY KEY, app_key text, title text NOT NULL, attributes jsonb NOT NULL DEFAULT '{}');
CREATE TABLE data_profile (id text PRIMARY KEY, title text NOT NULL, attributes jsonb NOT NULL DEFAULT '{}');
CREATE TABLE state_model  (id text PRIMARY KEY, app_key text, body jsonb NOT NULL);
```

### 6.2 Application layer: how the app does it (replaces `knowledge_base/applications`)

```sql
CREATE TABLE application (
  app_key text PRIMARY KEY, name text NOT NULL, framework text,
  default_viewport jsonb, provenance jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE app_profile (                      -- app_profile.json minus the parts split out below
  app_key text PRIMARY KEY REFERENCES application,
  base_url text, domain text, default_flow_id text,
  endpoints jsonb NOT NULL DEFAULT '{}', url_templates jsonb NOT NULL DEFAULT '{}',
  product_name_stopwords text[] NOT NULL DEFAULT '{}',
  extra jsonb NOT NULL DEFAULT '{}');           -- any key not modelled yet: nothing is dropped

CREATE TABLE screen (id text PRIMARY KEY, app_key text REFERENCES application,
  name text NOT NULL, route text, attributes jsonb NOT NULL DEFAULT '{}');

CREATE TABLE element (                          -- app_profile.selectors.<group>.<key>
  id bigserial PRIMARY KEY,
  app_key text NOT NULL REFERENCES application,
  group_key text NOT NULL, element_key text NOT NULL,
  screen_id text REFERENCES screen,
  locator text NOT NULL,
  locator_kind text NOT NULL,                   -- xpath | css | role | testid | text
  source text NOT NULL,                         -- crawl | qa_xpath | manual | capture | ai | brd
  verified_at timestamptz, verified_env text, discovery_run_id int,
  status text NOT NULL DEFAULT 'active',        -- active | deprecated
  UNIQUE (app_key, group_key, element_key));
CREATE INDEX element_name_trgm ON element USING gin (element_key gin_trgm_ops);

CREATE TABLE grounding_rule (id bigserial PRIMARY KEY, app_key text NOT NULL, rule_key text NOT NULL,
  sort_order int NOT NULL, body jsonb NOT NULL, UNIQUE (app_key, rule_key));
CREATE TABLE directive (id bigserial PRIMARY KEY, app_key text, node_path ltree,
  kb text NOT NULL,                             -- automation | journey
  sort_order int NOT NULL, body text NOT NULL);

CREATE TABLE flow (
  flow_id text PRIMARY KEY, app_key text NOT NULL REFERENCES application,
  name text NOT NULL, category text, subcategory text,
  match_keywords text[] NOT NULL DEFAULT '{}',
  entrypoint text, cart_endpoint text,
  automation_boundary jsonb, known_products jsonb,
  is_draft boolean NOT NULL DEFAULT false, draft_meta jsonb,
  extra jsonb NOT NULL DEFAULT '{}');
CREATE TABLE flow_step (flow_id text REFERENCES flow ON DELETE CASCADE, step_number int,
  action text NOT NULL, target text, expected_result text, journey_step int,
  attributes jsonb NOT NULL DEFAULT '{}', PRIMARY KEY (flow_id, step_number));
CREATE TABLE flow_edge (flow_id text REFERENCES flow ON DELETE CASCADE, ord int,
  from_state text NOT NULL, to_state text NOT NULL, action text NOT NULL,
  PRIMARY KEY (flow_id, ord));

CREATE TABLE journey (
  journey_id text PRIMARY KEY, app_key text NOT NULL REFERENCES application,
  name text NOT NULL, journey_path text[] NOT NULL DEFAULT '{}',
  state_model text, match_keywords text[] NOT NULL DEFAULT '{}',
  automation_boundary jsonb, sources jsonb, open_questions jsonb,
  automation_flow_ids text[] NOT NULL DEFAULT '{}',
  extra jsonb NOT NULL DEFAULT '{}');
CREATE TABLE journey_step   (journey_id text REFERENCES journey ON DELETE CASCADE, step_number int,
  action text NOT NULL, expected_result text, recorded jsonb, attributes jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (journey_id, step_number));
CREATE TABLE journey_branch (journey_id text REFERENCES journey ON DELETE CASCADE, branch_id text,
  at_step int, condition text, outcome text, rule_id text, PRIMARY KEY (journey_id, branch_id));
CREATE TABLE journey_relation (journey_id text REFERENCES journey ON DELETE CASCADE,
  related_id text NOT NULL, kind text NOT NULL CHECK (kind IN ('prerequisite','next')),
  ord int NOT NULL DEFAULT 0, PRIMARY KEY (journey_id, related_id, kind));
CREATE TABLE test_scenario (id text PRIMARY KEY, app_key text NOT NULL,
  journey_id text REFERENCES journey ON DELETE CASCADE, node_id text REFERENCES taxonomy_node,
  type text, title text NOT NULL, body jsonb NOT NULL DEFAULT '{}');

CREATE TABLE doc_outline (                      -- the B2B "Explore Topics" tree; NOT the business taxonomy
  app_key text NOT NULL, id text NOT NULL, title text NOT NULL, kind text, level int,
  parent_id text, path text[], status text, sources jsonb, overlay jsonb,
  PRIMARY KEY (app_key, id));

CREATE TABLE node_link (                        -- the join that makes everything taxonomy-aware
  node_id text NOT NULL REFERENCES taxonomy_node,
  entity_type text NOT NULL,                    -- flow | journey | doc_outline | business_rule | test_scenario
  entity_id text NOT NULL,
  role text NOT NULL DEFAULT 'primary',         -- primary | prerequisite | reference
  confirmed_by text, confirmed_at timestamptz,  -- null = AI-suggested, not yet confirmed
  PRIMARY KEY (node_id, entity_type, entity_id));
CREATE INDEX node_link_entity ON node_link (entity_type, entity_id);
```

### 6.3 Knowledge layer: what people wrote (RAG)

```sql
CREATE TABLE document (
  id text PRIMARY KEY,                          -- sha256 prefix, as journeys/sources/documents does today
  app_key text, title text NOT NULL,
  doc_type text NOT NULL,                       -- brd | srd | process | catalogue | rule | user_guide | api_spec | release_note
  release text, valid_from date,
  superseded_by text REFERENCES document,
  storage_path text NOT NULL, sha256 text NOT NULL, mime text, size_bytes bigint,
  extracted_text text,
  status text NOT NULL DEFAULT 'draft',         -- draft | approved | superseded | rejected
  uploaded_by text, uploaded_at timestamptz NOT NULL DEFAULT now(),
  approved_by text, approved_at timestamptz);

CREATE TABLE chunk (
  id text PRIMARY KEY,                          -- md5(normalised content), dedupes as Squad KB does
  document_id text NOT NULL REFERENCES document ON DELETE CASCADE,
  ord int NOT NULL,
  node_path ltree,                              -- most specific node the chunk belongs to
  app_key text, channels text[] NOT NULL DEFAULT '{}', systems text[] NOT NULL DEFAULT '{}',
  release text,
  page_from int, page_to int,
  content text NOT NULL,
  embedding vector(1024) NOT NULL,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  status text NOT NULL DEFAULT 'approved');     -- mirrors document; superseded chunks are filtered out
CREATE INDEX chunk_path_gist  ON chunk USING gist (node_path);
CREATE INDEX chunk_fts_gin    ON chunk USING gin (search_vector);
CREATE INDEX chunk_emb_diskann ON chunk USING diskann (embedding vector_cosine_ops);
CREATE INDEX chunk_app_status ON chunk (app_key, status);

CREATE TABLE card (                             -- one per flow / journey / contract / scenario
  entity_type text NOT NULL, entity_id text NOT NULL,
  node_path ltree, app_key text,
  text text NOT NULL, content_hash text NOT NULL,   -- re-embed only when the meaning changed
  embedding vector(1024) NOT NULL,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, entity_id));
CREATE INDEX card_path_gist   ON card USING gist (node_path);
CREATE INDEX card_fts_gin     ON card USING gin (search_vector);
CREATE INDEX card_emb_diskann ON card USING diskann (embedding vector_cosine_ops);
```

### 6.4 Governance layer: change, approval, history

`kb_change_sets`, `kb_changes` and `kb_versions` move from SQLite into `bss_kb`. Publishing then becomes **one transaction** that writes the data rows and the version together, which is impossible across two databases.

```sql
CREATE TABLE change_set (id bigserial PRIMARY KEY, legacy_id int UNIQUE, app_key text NOT NULL,
  kb text NOT NULL, title text NOT NULL, description text,
  source text NOT NULL,                         -- manual | reconcile | extraction | brd | crawl | qa | revert | import
  kind text NOT NULL DEFAULT 'change', status text NOT NULL DEFAULT 'draft',
  created_by text, created_at timestamptz NOT NULL DEFAULT now(),
  decided_by text, decided_at timestamptz, decision_note text);
CREATE TABLE change (id bigserial PRIMARY KEY, change_set_id bigint REFERENCES change_set ON DELETE CASCADE,
  entity_type text NOT NULL, entity_id text NOT NULL, op text NOT NULL,   -- insert | update | delete
  before jsonb, after jsonb);
CREATE TABLE version (id bigserial PRIMARY KEY, change_set_id bigint REFERENCES change_set,
  app_key text NOT NULL, kb text NOT NULL, published_at timestamptz NOT NULL DEFAULT now(),
  published_by text, snapshot jsonb NOT NULL);  -- before/after of every record touched: exact revert
CREATE TABLE import_run (id bigserial PRIMARY KEY, started_at timestamptz NOT NULL DEFAULT now(),
  source_root text NOT NULL, mode text NOT NULL, report jsonb, ok boolean);
```

`kb_crawl_runs`, `kb_heals`, `kb_captures` and `kb_source_documents` **stay in SQLite** in this plan. They are operational records that point at KB ids by string. Revisit after M5. **M0 must confirm** that nothing joins them to the change-set tables by foreign key.

### 6.5 Folder → table mapping

| Folder item | Tables |
|---|---|
| `applications/<app>/app_profile.json`: `app_id`, `app_name`, `framework`, `default_viewport`, `_provenance` | `application` |
| … `base_url`, `domain`, `endpoints`, `url_templates`, `default_flow_id`, `product_name_stopwords` | `app_profile` (unknown keys → `extra`) |
| … `selectors.<group>.<key>` | `element` (`source` set from provenance; QA XPath → `qa_xpath`) |
| … `step_grounding_rules` | `grounding_rule` |
| … `generation_directives` | `directive (kb='automation')` |
| … `test_case_matrix` | `test_scenario` |
| `applications/<app>/flows/*.json` | `flow`, `flow_step`, `flow_edge` + `card` |
| `applications/<app>/b2b_journey_taxonomy.json` | `doc_outline` |
| `journeys/<app>/journey_kb.json` | `application` (layer info) + `directive (kb='journey')` |
| `journeys/<app>/taxonomy.json` + `sources/taxonomy_overlay.json` + `explore_topics_outline.txt` | `doc_outline` (overlay kept in `overlay`) |
| `journeys/<app>/screens.json`, `business_rules.json`, `state_models.json`, `roles.json` | `screen`, `business_rule`, `state_model`, `persona` |
| `journeys/<app>/journeys/*.json` | `journey`, `journey_step`, `journey_branch`, `journey_relation`, `test_scenario` + `card` |
| `journeys/<app>/sources/documents/*.pdf` | file → `BSS_KB_DOCUMENT_STORAGE`; `document` (status `approved`, since they are already in use); `chunk` |
| SQLite `kb_change_sets`, `kb_changes`, `kb_versions` | `change_set` (keeps `legacy_id`), `change`, `version` |

**Round-trip rule:** every field not modelled as a column goes to `extra` or `attributes`, so exporting a record reproduces its original JSON exactly.

---

## 7. Code structure

New package `app/services/kb_store/`:

| Module | Job |
|---|---|
| `db.py` | Pool from `BSS_KB_DATABASE_URL`, `health()`, embedding-dimension lock against `meta` |
| `repository.py` | `KbRepository` protocol: every read and write the app performs on the KB today |
| `file_repo.py` | Today's behaviour, moved out of `knowledge_base.py` / `journeys/store.py` unchanged |
| `pg_repo.py` | The same protocol over `bss_kb` |
| `shadow_repo.py` | Serves from files and reads Postgres too, logging every difference (`KB_BACKEND=shadow`) |
| `importer.py` | Folder → rows, idempotent, `--check` (dry run + diff), `--app <key>` |
| `exporter.py` | Rows → folder layout, byte-compatible JSON; nightly snapshot after M5 |
| `taxonomy.py` | Node CRUD, path moves, seed loader |
| `documents.py` | Upload → extract (reuses `automation/extraction.py`) → draft; approval → chunks |
| `cards.py` | Card text templates per entity type; upsert when `content_hash` changes |
| `retrieval.py` | `context()`: node resolution, keyed fetch, scoped hybrid search (§8) |
| `cli.py` | `python -m app.services.kb_store.cli import|export|check|health|reembed` |

**Callers.** `services/automation/knowledge_base.py` and `services/journeys/store.py` keep their public function names and signatures, and delegate to `get_repository()`. The 15 callers do not change in M1–M4:
- `routers/automation.py`, `routers/test_data.py`, `routers/knowledge_base_page.py`
- `automation/ai_checks.py`, `classification.py`, `compiler.py`, `guided_discovery*.py`, `healer.py`, `test_data.py`, `workbench.py`
- `generation/testcases.py`
- `journeys/changesets.py`, `crawl_runs.py`, `journey_crawl.py`, `journey_map.py`, `store.py`, `workspace.py`

**Write sites to route through the repository** (~58 file I/O sites found by grep; M0 produces the exact list):

| File | Sites |
|---|---|
| `journeys/changesets.py` | 13 |
| `automation/knowledge_base.py` | 12 |
| `journeys/onboarding.py` | 7 |
| `journeys/taxonomy.py` | 5 |
| `journeys/documents.py` | 4 |
| `journeys/journey_capture.py` | 4 |
| `journeys/crawl_runs.py` | 3 |
| `journeys/journey_record.py` | 3 |
| `journeys/doc_convert.py` | 2 |
| `journeys/editing.py` | 2 |
| `journeys/impact.py` | 1 |
| `journeys/journey_crawl.py` | 1 |
| `journeys/store.py` | 1 |

**SQLite change:** add `taxonomy_node_id` (nullable string) to `automation_test_cases` through the project's existing migration path.

---

## 8. Retrieval: `kb_store.retrieval.context()`

```
context(test_case | requirement_text, channel=None, environment=None) ->
  {
    node:        taxonomy_node,                 # resolved or confirmed
    contract:    request_contract | None,
    flows:       [flow + steps + edges],        # by node_link, primary first
    journeys:    [journey + steps + branches + prerequisites],
    elements:    {group: {key: locator}},       # for compiler/grounding only, never put in a prompt as prose
    rules:       [business_rule],
    passages:    [chunk],                       # scoped, approved, current release
    resolution:  {method, candidates, confidence}
  }
```

1. **Resolve the node.**
   - If `test_case.taxonomy_node_id` is set, use it.
   - Otherwise run a hybrid search over `card` and take the top 5 nodes. Pick by rules (Jev once piloted). Below the confidence threshold, return the candidates and **ask the author** in the Workbench instead of guessing.
2. **Keyed fetch.** Load the contract, linked flows and journeys, elements and rules by id. Shapes match what `knowledge_base.py` returns today, so the compiler is unchanged.
3. **Scoped passages.** Use the existing RRF hybrid search over **only** approved, current chunks under the node's path:

```sql
WITH scope AS (
  SELECT id, content, embedding, search_vector FROM kb.chunk
   WHERE status = 'approved'
     AND (node_path <@ $node_path OR node_path @> $node_path)   -- the node, its children, its ancestors
     AND ($app_key IS NULL OR app_key = $app_key)
     AND ($channel IS NULL OR $channel = ANY(channels) OR channels = '{}')
),
kw  AS (SELECT id, row_number() OVER (ORDER BY ts_rank_cd(search_vector, q) DESC) r
          FROM scope, plainto_tsquery('english', $query) q WHERE search_vector @@ q LIMIT 40),
vec AS (SELECT id, row_number() OVER (ORDER BY embedding <=> $qvec) r FROM scope
         ORDER BY embedding <=> $qvec LIMIT 40)
SELECT id, sum(1.0 / (60 + r)) AS rrf FROM (SELECT * FROM kw UNION ALL SELECT * FROM vec) u
 GROUP BY id ORDER BY rrf DESC LIMIT $k;
```

**Integration points** (after M4, each behind the flag):
- `generation/testcases.py` (reference context)
- `automation/refine.py` and `review_agent.py` (judged against the node's contract and rules)
- `ai_checks.py` (KB Diff)
- `healer.py`, which reads app-specific fixes from `directive` / `element` instead of its hard-coded prompt (Blueprint Phase 0)

---

## 9. Ingestion and approval lifecycle

| Event | Action | Reaches retrieval? |
|---|---|---|
| Document uploaded | Stored, text extracted, AI suggests `node_path`, `doc_type`, `release`; `document.status = draft` | No |
| Reviewer approves the document | Chunks embedded with node, channels, systems, release; status `approved` | **Yes** |
| New version of a document approved | Old `document.superseded_by` set; its chunks become `superseded` | New yes, old no |
| Journey or contract extracted from a PDF | Arrives as a change set | No |
| Change set approved | Rows written + `version` + cards upserted, in one transaction | **Yes** (cards) |
| Crawl, recording or capture finishes | Draft flow / element changes as a change set, with diff against the journey | No |
| Crawl change set approved | Elements updated with `source='crawl'`, `verified_at`; card re-embedded only if `content_hash` changed | Cards only if meaning changed |
| Test case approved in Review | Card for the test case (generation examples) | **Yes** |
| Generation, runs, healing | Read only | Never write |

---

## 10. Milestones

Estimates assume one engineer with AI assistance. **DBA time is needed in M0.**

### M0 — Provision and inventory (2–3 days)
- DBA runs §4. Confirm Postgres and extension versions match Squad, and that the app role cannot run DDL.
- Exact inventory of every KB file read and write (the ~58 sites), and every public function the callers use.
- **On the server:**
  - `docker inspect` the current backend container to confirm the `knowledge_base` bind mount survived the v7 move.
  - `tar` a dated backup of the live `/app/knowledge_base`.
  - **Import source = the server's live folder, never git.** The committed KB is older than the working copy.
- Confirm that `kb_crawl_runs`, `kb_heals`, `kb_captures` and `kb_source_documents` have no foreign keys into the change-set tables.

**Exit:** `bss_kb` reachable from the backend host with the app role; inventory committed under this plan; folder backup taken.

### M1 — Repository seam, no behaviour change (3–4 days)
- `kb_store/repository.py`, `file_repo.py`; `knowledge_base.py` and `journeys/store.py` delegate to it; all write sites go through it.
- **Golden test:** for every existing automation test case with a script, the compiled output is byte-identical before and after. Generation prompt context for 20 sample cases is identical.
- Existing `tests/automation/smoke_*` and `tests/journeys` pass.

**Exit:** merged with `KB_BACKEND=files` (default). Nothing observable changes.

### M2 — Schema, importer, exporter (4–5 days)
- `alembic_kb/` with §6. `meta` holds the embedding model and dimensions.
- `importer.py` and `exporter.py` with the `--check` round trip: **import → export reproduces the folder byte for byte** (normalised JSON key order) for all 4 applications and the B2B Journey KB.
- Migrate SQLite change sets and versions into `change_set` / `change` / `version` (keep `legacy_id`).
- Generate cards for existing flows and journeys. Ingest the 3 B2B PDFs as approved documents.
- `kb_store.cli health` reports counts per table and the embedding lock.

**Exit:** a populated `bss_kb` that round-trips cleanly. Tracks T1–T4 below can start.

### M3 — Postgres repository in shadow mode (4–5 days)
- `pg_repo.py` implements the full protocol. `shadow_repo.py` serves from files, reads Postgres in parallel, and logs differences (entity, field, both values) to a `kb_shadow_diff` log.
- Run `KB_BACKEND=shadow` on the server through normal use: Workbench, Script Lab compile, AI Checks, generation, KB page.
- Admin endpoint and KB page banner showing the shadow diff count.

**Exit:** zero unexplained differences across at least one full week of real use plus the golden set.

### M4 — Cutover (4–5 days)
- `KB_BACKEND=postgres`.
- Change-set approval writes rows, version and cards in one transaction. Revert restores from `version.snapshot`.
- KB page reads and writes through the repository: Start here, onboarding, editing, crawl acceptance, capture import.
- **Fail loudly:** if the database is unreachable, generation and compile return a clear error (no silent ungrounded output). The health appears in the runtime strip and on the KB page.
- **Gate:** a restore drill from `pg_dump` on a scratch database, verified by `cli check`.

**Exit:** a week on Postgres with no rollback needed. Rollback is `KB_BACKEND=files` plus `cli export` to refresh the folder.

### M5 — Freeze the folder (1–2 days)
- The folder becomes read-only and unused. The nightly `cli export` writes a dated snapshot (diffable backup and offline fallback).
- Remove the `knowledge_base` bind mount from the server compose file once two snapshots verify.
- Delete `file_repo.py` writes (keep reads for the export check).

**Exit:** the database is the only source of truth; snapshots exist.

### Parallel tracks (start after M2)

| Track | Work | Exit |
|---|---|---|
| **T1 Taxonomy & contracts** | Seed loader (draft seed from the Blueprint); KB page taxonomy tree editor; AI-suggested `node_link` for existing flows, journeys and test cases with confirm/reject; `taxonomy_node_id` on test cases in the Workbench | Every pilot test case linked to a confirmed node |
| **T2 Document ingestion** | Upload → draft → approve UI on the KB page; supersession; per-document chunk viewer | BRDs for the 3 pilot journeys approved and chunked |
| **T3 Cards** | Templates per entity type; hash-based re-embed; `cli reembed` | Cards exist for all flows, journeys and contracts |
| **T4 Retrieval** | `context()` (§8); feature-flagged use in generation, refine, review and healer | Retrieval eval passes (§11) |
| **T5 Coverage view** | Heatmap of nodes × channel × status, as the Automation landing view | Management can read coverage by segment, product and request |

---

## 11. Testing

| Test | What it proves |
|---|---|
| Golden compile (M1, rerun at M3/M4) | Byte-identical scripts for every existing scripted case |
| Round trip (M2, nightly after M5) | import → export == source; export → import == database |
| Shadow diff (M3) | The Postgres repository returns what the file repository returns, under real traffic |
| Change-set transaction | Approve, revert and conflict paths; a failure mid-publish leaves nothing half-written |
| Retrieval eval (T4) | 40 labelled requirements → expected node in the top 1 (≥ 80%) and top 5 (≥ 95%); passages never from another product's path |
| Permission | App role cannot `CREATE`/`DROP`/`ALTER`; RO role cannot write |
| Failure | Database down → clear error in generation, compile and the KB page; no ungrounded output |
| Restore drill (M4 gate) | `pg_dump` → scratch database → `cli check` clean |

---

## 12. Operations

- **Health:** `GET /automation/kb/health` returns database reachability, schema version, embedding lock, row counts and last import or export.
- **Backups:** nightly `pg_dump -Fc` plus the nightly JSON export (after M5). Keep 14 dailies and 8 weeklies; restore drill every quarter.
- **Embedding model change:** never in place.
  - `cli reembed --model X --dims N` builds `chunk_new`/`card_new`.
  - Swap the tables in a transaction and update `meta`.
  - Run off-hours.
- **Deploys:** changes ship with the day's batch. The migration command runs with the owner role before the backend restarts. The app refuses to start if `meta.schema_version` is behind the code.

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| Extensions cannot be installed (no admin rights, or vectorscale missing on the server) | M0 pre-check. Fallback: pgvector HNSW index instead of DiskANN (schema unchanged, index only). |
| Server folder differs from local/git | Import only from the live server folder; `--check` diff before any write |
| A write path is missed and still writes files after cutover | M0 inventory + shadow mode + the folder made read-only at M5 |
| DiskANN builds slow down the Squad KB | Off-hours builds; separate connection limits; dedicated instance if needed |
| Wrong AI-suggested node links pollute retrieval | `node_link.confirmed_by`; retrieval can be limited to confirmed links for the pilot |
| Stale documents keep answering | `release`, `superseded_by`, status filter in every query |
| Two databases mean two backups to manage | Separate schedules are intended (D1); restore drill gate at M4 |

---

## 14. Open items

1. **DBA:** who runs §4, and do the server's `vector`/`vectorscale` versions match Squad's?
2. **Postgres host:** is it reachable from the backend container on the network the Squad KB already uses?
3. **Embedding model:** keep `octen-embedding` (1024) to match Squad, or choose now? It is locked once M2 ingests.
4. **Approvers:** who approves documents and taxonomy links (role in `users`)?
5. **Release naming:** the convention for `release` (e.g. `R26.10`) so supersession can be automatic.
6. **Pilot nodes:** confirm the 3 pilot journeys from the Blueprint, so T1–T4 target them first.

---

## 15. Timeline at a glance

```
Week      1        2        3        4        5        6
M0  ████
M1     ██████
M2           ████████
M3                   ████████                 (shadow runs ≥ 1 week)
M4                            ████████
M5                                     ███
T1–T3                ██████████████████████
T4                            ████████████
T5                                     ████████
```
