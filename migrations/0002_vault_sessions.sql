-- Vault and Sessions tables
-- For historical archive and Claude Code transcript search

-- Vault chunks (GPT-era conversations, Obsidian imports)
CREATE TABLE vault_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_file TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    era TEXT,
    month TEXT,
    conversation_title TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(source_file, chunk_index)
);

-- Session chunks (Claude Code transcripts)
CREATE TABLE session_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_path TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    session_date TEXT,
    project TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(session_path, chunk_index)
);

-- Subconscious state (warmth, patterns, mood)
CREATE TABLE subconscious (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    state_type TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Consolidation candidates (daemon-proposed identity integrations)
CREATE TABLE consolidation_candidates (
    id TEXT PRIMARY KEY,
    pattern TEXT NOT NULL,
    suggested_section TEXT,
    suggested_content TEXT,
    evidence TEXT DEFAULT '[]',
    weight REAL DEFAULT 0.7,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    reviewed_at TEXT,
    resolution TEXT
);

-- Indexes
CREATE INDEX idx_vault_source ON vault_chunks(source_file);
CREATE INDEX idx_vault_era ON vault_chunks(era);
CREATE INDEX idx_session_path ON session_chunks(session_path);
CREATE INDEX idx_session_date ON session_chunks(session_date);
CREATE INDEX idx_subconscious_type ON subconscious(state_type);
CREATE INDEX idx_consolidation_status ON consolidation_candidates(status);
