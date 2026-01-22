-- Emotional Processing Architecture v2
-- Adds metabolization tracking to notes (emotional observations)

-- Add charge level and sitting mechanics to notes
ALTER TABLE notes ADD COLUMN charge TEXT DEFAULT 'fresh';
ALTER TABLE notes ADD COLUMN sit_count INTEGER DEFAULT 0;
ALTER TABLE notes ADD COLUMN last_sat_at TEXT;

-- Add resolution linking
ALTER TABLE notes ADD COLUMN resolution_note TEXT;
ALTER TABLE notes ADD COLUMN resolved_at TEXT;
ALTER TABLE notes ADD COLUMN linked_insight_id INTEGER REFERENCES notes(id);

-- Index for surfacing unprocessed emotions
CREATE INDEX idx_notes_charge ON notes(charge);
CREATE INDEX idx_notes_weight_charge ON notes(weight, charge);

-- Sitting history (optional - for tracking journey of processing)
CREATE TABLE note_sits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id INTEGER NOT NULL,
    sit_note TEXT,
    sat_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
);

CREATE INDEX idx_note_sits_note ON note_sits(note_id);
