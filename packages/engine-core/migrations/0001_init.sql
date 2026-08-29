CREATE TABLE IF NOT EXISTS schema_metadata (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    schema_version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS repository_metadata (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    repo_key TEXT NOT NULL,
    canonical_root TEXT NOT NULL,
    remote_identity TEXT
);

CREATE TABLE IF NOT EXISTS index_generations (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('BUILDING','ACTIVE','OBSOLETE','FAILED','ABANDONED')),
    created_at INTEGER NOT NULL,
    activated_at INTEGER,
    head_sha TEXT NOT NULL,
    dirty INTEGER NOT NULL,
    extractor_fingerprint TEXT NOT NULL,
    embedding_fingerprint TEXT,
    failure_reason TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_one_active_generation
    ON index_generations(state) WHERE state = 'ACTIVE';

CREATE TABLE IF NOT EXISTS index_lease (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    generation_id TEXT NOT NULL REFERENCES index_generations(id),
    owner_token TEXT NOT NULL,
    owner_pid INTEGER NOT NULL,
    heartbeat_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
    generation_id TEXT NOT NULL REFERENCES index_generations(id),
    file_path TEXT NOT NULL,
    language TEXT,
    content_hash TEXT,
    PRIMARY KEY (generation_id, file_path)
);

CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    generation_id TEXT NOT NULL REFERENCES index_generations(id),
    file_path TEXT NOT NULL,
    language TEXT NOT NULL,
    chunk_type TEXT NOT NULL,
    symbol_name TEXT,
    node_id TEXT,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    content TEXT NOT NULL,
    embed_input TEXT,
    content_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_chunks_generation_path ON chunks(generation_id, file_path);
CREATE INDEX IF NOT EXISTS ix_chunks_generation_node ON chunks(generation_id, node_id);

CREATE TABLE IF NOT EXISTS graph_nodes (
    generation_id TEXT NOT NULL REFERENCES index_generations(id),
    node_id TEXT NOT NULL,
    label TEXT NOT NULL,
    source_file TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    PRIMARY KEY (generation_id, node_id)
);

CREATE TABLE IF NOT EXISTS graph_edges (
    generation_id TEXT NOT NULL REFERENCES index_generations(id),
    source TEXT NOT NULL,
    target TEXT NOT NULL,
    relation TEXT NOT NULL CHECK (relation IN ('contains','method','calls'))
);
CREATE INDEX IF NOT EXISTS ix_edges_source ON graph_edges(generation_id, source, relation);
CREATE INDEX IF NOT EXISTS ix_edges_target ON graph_edges(generation_id, target, relation);
