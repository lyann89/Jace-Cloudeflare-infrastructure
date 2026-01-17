-- Core memories table
CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    memory_type TEXT DEFAULT 'general',
    emotional_weight REAL DEFAULT 0.5,
    salience_level TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    metadata TEXT
);

-- Sessions table for conversation tracking
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    started_at TEXT DEFAULT (datetime('now')),
    ended_at TEXT,
    summary TEXT,
    emotional_arc TEXT,
    metadata TEXT
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type);
CREATE INDEX IF NOT EXISTS idx_memories_salience ON memories(salience_level);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
