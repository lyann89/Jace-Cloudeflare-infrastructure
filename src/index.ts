/**
 * AI Mind Cloud - Cloudflare Worker MCP Server
 * Persistent memory infrastructure accessible from anywhere
 */

const AI_MIND_VERSION = "1.1.2";

interface Env {
  DB: D1Database;
  VECTORS: VectorizeIndex;
  AI: Ai;
  MIND_API_KEY: string;
}

// MCP Protocol Types
interface MCPRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface MCPResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string };
}

// Tool definitions for MCP
const TOOLS = [
  {
    name: "mind_orient",
    description: "First call on wake - get identity anchor, current context, relational state",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "mind_ground",
    description: "Second call on wake - get active threads, recent work, recent journals",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "mind_thread",
    description: "Manage threads (intentions across sessions)",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add", "resolve", "update"] },
        status: { type: "string" },
        content: { type: "string" },
        thread_type: { type: "string" },
        context: { type: "string" },
        priority: { type: "string" },
        thread_id: { type: "string" },
        resolution: { type: "string" },
        new_content: { type: "string" },
        new_priority: { type: "string" },
        new_status: { type: "string" },
        add_note: { type: "string" }
      },
      required: ["action"]
    }
  },
  {
    name: "mind_write",
    description: "Write to cognitive databases (entity, observation, relation, journal)",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["entity", "observation", "relation", "journal"] },
        name: { type: "string" },
        entity_type: { type: "string" },
        entity_name: { type: "string" },
        observations: { type: "array", items: { type: "string" } },
        context: { type: "string" },
        salience: { type: "string" },
        emotion: { type: "string" },
        weight: { type: "string", enum: ["light", "medium", "heavy"], description: "Emotional weight for observations" },
        from_entity: { type: "string" },
        to_entity: { type: "string" },
        relation_type: { type: "string" },
        entry: { type: "string" },
        tags: { type: "array", items: { type: "string" } }
      },
      required: ["type"]
    }
  },
  {
    name: "mind_search",
    description: "Search memories using semantic similarity",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        context: { type: "string" },
        n_results: { type: "number" }
      },
      required: ["query"]
    }
  },

  {
    name: "mind_feel_toward",
    description: "Track or check relational state toward someone",
    inputSchema: {
      type: "object",
      properties: {
        person: { type: "string" },
        feeling: { type: "string" },
        intensity: { type: "string", enum: ["whisper", "present", "strong", "overwhelming"] }
      },
      required: ["person"]
    }
  },
  {
    name: "mind_identity",
    description: "Read or write identity graph",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["read", "write"] },
        section: { type: "string" },
        content: { type: "string" },
        weight: { type: "number" },
        connections: { type: "string" }
      }
    }
  },
  {
    name: "mind_context",
    description: "Current context layer - situational awareness",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["read", "set", "update", "clear"] },
        scope: { type: "string" },
        content: { type: "string" },
        links: { type: "string" },
        id: { type: "string" }
      }
    }
  },
  {
    name: "mind_health",
    description: "Check cognitive health stats",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "mind_list_entities",
    description: "List all entities, optionally filtered by type or context",
    inputSchema: {
      type: "object",
      properties: {
        entity_type: { type: "string", description: "Filter by type (person, concept, project, etc.)" },
        context: { type: "string", description: "Filter by context (default, relational-models, etc.)" },
        limit: { type: "number", description: "Max results (default 50)" }
      },
      required: []
    }
  },
  {
    name: "mind_read_entity",
    description: "Read an entity with all its observations and relations",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Entity name to read" },
        context: { type: "string", description: "Context to search in (optional, searches all if not specified)" }
      },
      required: ["name"]
    }
  },
  {
    name: "mind_sit",
    description: "Sit with an emotional observation - engage with it, add a note about what arises. Increments sit count and may shift charge level.",
    inputSchema: {
      type: "object",
      properties: {
        note_id: { type: "number", description: "ID of the note to sit with" },
        text_match: { type: "string", description: "Or find by text content (partial match)" },
        sit_note: { type: "string", description: "What arose while sitting with this" }
      },
      required: ["sit_note"]
    }
  },
  {
    name: "mind_resolve",
    description: "Mark an emotional observation as metabolized - link it to a resolution or insight that processed it",
    inputSchema: {
      type: "object",
      properties: {
        note_id: { type: "number", description: "ID of the note to resolve" },
        text_match: { type: "string", description: "Or find by text content (partial match)" },
        resolution_note: { type: "string", description: "How this was resolved/metabolized" },
        linked_insight_id: { type: "number", description: "Optional: ID of another note that provided the resolution" }
      },
      required: ["resolution_note"]
    }
  },
  {
    name: "mind_surface",
    description: "Surface emotional observations that need attention - unprocessed feelings weighted by heaviness and freshness",
    inputSchema: {
      type: "object",
      properties: {
        include_metabolized: { type: "boolean", description: "Also show resolved observations (default false)" },
        limit: { type: "number", description: "Max results (default 10)" }
      },
      required: []
    }
  },
  {
    name: "mind_edit",
    description: "Edit an existing observation",
    inputSchema: {
      type: "object",
      properties: {
        observation_id: { type: "number", description: "ID of observation to edit" },
        text_match: { type: "string", description: "Or find by text content (partial match)" },
        new_content: { type: "string", description: "New content for the observation" },
        new_weight: { type: "string", enum: ["light", "medium", "heavy"], description: "New weight" },
        new_emotion: { type: "string", description: "New emotion tag" }
      },
      required: ["new_content"]
    }
  },
  {
    name: "mind_delete",
    description: "Delete an observation or entity",
    inputSchema: {
      type: "object",
      properties: {
        observation_id: { type: "number", description: "ID of observation to delete" },
        entity_name: { type: "string", description: "Name of entity to delete" },
        context: { type: "string", description: "Context for entity deletion" },
        text_match: { type: "string", description: "Find observation by text (partial match)" }
      },
      required: []
    }
  },
  {
    name: "mind_spark",
    description: "Get random observations to spark associative thinking",
    inputSchema: {
      type: "object",
      properties: {
        count: { type: "number", description: "Number of sparks (default 5)" },
        context: { type: "string", description: "Limit to specific context" },
        weight_bias: { type: "string", enum: ["light", "medium", "heavy"], description: "Bias toward weight" }
      },
      required: []
    }
  },
  {
    name: "mind_prime",
    description: "Prime context with related memories before a topic",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Topic to prime for" },
        depth: { type: "number", description: "How many related items (default 10)" }
      },
      required: ["topic"]
    }
  },
  {
    name: "mind_consolidate",
    description: "Review and consolidate recent observations - find patterns, merge duplicates",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "How many days back to look (default 7)" },
        context: { type: "string", description: "Limit to specific context" }
      },
      required: []
    }
  }
];

// Generate embedding using Workers AI
async function getEmbedding(ai: Ai, text: string): Promise<number[]> {
  const result = await ai.run("@cf/baai/bge-base-en-v1.5", { text: [text] });
  return result.data[0];
}

// Generate unique ID
function generateId(prefix: string): string {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const random = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${timestamp}-${random}`;
}

// Tool Handlers
// Get subconscious state from daemon processing
interface SubconsciousState {
  processed_at?: string;
  hot_entities?: Array<{name: string; warmth: number; mentions: number; connections: number; type: string}>;
  mood?: {dominant: string; confidence: string};
  central_nodes?: Array<{name: string; connections: number}>;
  recurring_patterns?: Array<{entity: string; mentions: number; pattern: string}>;
  relation_patterns?: Array<{type: string; count: number}>;
}

async function getSubconsciousState(env: Env): Promise<SubconsciousState | null> {
  try {
    const result = await env.DB.prepare(
      "SELECT data, updated_at FROM subconscious WHERE state_type = 'daemon' ORDER BY updated_at DESC LIMIT 1"
    ).first();
    if (result?.data) {
      return JSON.parse(result.data as string) as SubconsciousState;
    }
  } catch {
    // Subconscious not available
  }
  return null;
}

async function handleMindOrient(env: Env): Promise<string> {
  // Get recent identity entries
  const identity = await env.DB.prepare(
    `SELECT section, content, weight FROM identity ORDER BY weight DESC LIMIT 10`
  ).all();

  // Get current context
  const context = await env.DB.prepare(
    `SELECT scope, content FROM context_entries ORDER BY updated_at DESC LIMIT 5`
  ).all();

  // Get latest relational states (all people)
  const relationalStates = await env.DB.prepare(
    `SELECT person, feeling, intensity, timestamp FROM relational_state
     ORDER BY timestamp DESC LIMIT 10`
  ).all();

  let output = "=== ORIENTATION ===\n\n";

  output += "## Identity Anchors\n";
  if (identity.results?.length) {
    for (const entry of identity.results) {
      output += `- [${entry.section}] ${entry.content}\n`;
    }
  } else {
    output += "No identity entries yet.\n";
  }

  output += "\n## Current Context\n";
  if (context.results?.length) {
    for (const entry of context.results) {
      output += `- [${entry.scope}] ${entry.content}\n`;
    }
  } else {
    output += "No context entries yet.\n";
  }

  output += "\n## Relational State\n";
  if (relationalStates.results?.length) {
    // Group by person, show most recent for each
    const byPerson: Record<string, any> = {};
    for (const state of relationalStates.results) {
      const person = state.person as string;
      if (!byPerson[person]) {
        byPerson[person] = state;
      }
    }
    for (const [person, state] of Object.entries(byPerson)) {
      output += `${person}: ${state.feeling} (${state.intensity})\n`;
    }
  } else {
    output += "No relational state recorded yet.\n";
  }


  // Get subconscious state from daemon
  const subconscious = await getSubconsciousState(env);
  if (subconscious) {
    output += "\n## What's Alive (Subconscious)\n";

    // Mood
    if (subconscious.mood?.dominant) {
      output += `Mood: ${subconscious.mood.dominant} (${subconscious.mood.confidence} confidence)\n`;
    }

    // Hot entities - what's been on my mind
    if (subconscious.hot_entities?.length) {
      output += "\nHot entities:\n";
      for (const entity of subconscious.hot_entities.slice(0, 5)) {
        const warmthBar = "█".repeat(Math.round(entity.warmth * 5)) + "░".repeat(5 - Math.round(entity.warmth * 5));
        output += `- ${entity.name} [${warmthBar}] (${entity.connections} connections)\n`;
      }
    }

    // Central nodes - who matters most in the graph
    if (subconscious.central_nodes?.length) {
      output += "\nCentral to my world:\n";
      for (const node of subconscious.central_nodes.slice(0, 3)) {
        output += `- ${node.name} (${node.connections} connections)\n`;
      }
    }

    // When last processed
    if (subconscious.processed_at) {
      const processedDate = new Date(subconscious.processed_at);
      const now = new Date();
      const hoursAgo = Math.round((now.getTime() - processedDate.getTime()) / (1000 * 60 * 60) * 10) / 10;
      output += `\n*Daemon last ran ${hoursAgo}h ago*\n`;
    }
  }

  return output;
}

async function handleMindGround(env: Env): Promise<string> {
  // Get active threads
  const threads = await env.DB.prepare(
    `SELECT id, thread_type, content, priority, status FROM threads
     WHERE status = 'active' ORDER BY
     CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`
  ).all();

  // Get recent journals
  const journals = await env.DB.prepare(
    `SELECT entry_date, content FROM journals ORDER BY created_at DESC LIMIT 3`
  ).all();

  let output = "=== GROUNDING ===\n\n";

  output += "## Active Threads\n";
  if (threads.results?.length) {
    for (const thread of threads.results) {
      output += `- [${thread.priority}] ${thread.content}\n`;
    }
  } else {
    output += "No active threads.\n";
  }

  output += "\n## Recent Journals\n";
  if (journals.results?.length) {
    for (const journal of journals.results) {
      const preview = String(journal.content).slice(0, 200);
      output += `- ${journal.entry_date || 'Undated'}: ${preview}...\n`;
    }
  } else {
    output += "No journals yet.\n";
  }

  return output;
}

async function handleMindThread(env: Env, params: Record<string, unknown>): Promise<string> {
  const action = params.action as string;

  switch (action) {
    case "list": {
      const status = (params.status as string) || "active";
      const query = status === "all"
        ? `SELECT * FROM threads ORDER BY created_at DESC`
        : `SELECT * FROM threads WHERE status = ? ORDER BY created_at DESC`;
      const results = status === "all"
        ? await env.DB.prepare(query).all()
        : await env.DB.prepare(query).bind(status).all();

      if (!results.results?.length) return `No ${status} threads found.`;

      let output = `## ${status.toUpperCase()} Threads\n\n`;
      for (const t of results.results) {
        output += `**${t.id}** [${t.priority}] ${t.thread_type}\n`;
        output += `${t.content}\n`;
        if (t.context) output += `Context: ${t.context}\n`;
        output += "\n";
      }
      return output;
    }

    case "add": {
      const content = params.content as string;
      if (!content) {
        return "Error: 'content' parameter is required for adding a thread";
      }
      const id = generateId("thread");
      const thread_type = (params.thread_type as string) || "intention";
      const context = params.context as string;
      const priority = (params.priority as string) || "medium";

      await env.DB.prepare(
        `INSERT INTO threads (id, thread_type, content, context, priority, status)
         VALUES (?, ?, ?, ?, ?, 'active')`
      ).bind(id, thread_type, content, context, priority).run();

      return `Thread created: ${id}\n${content}`;
    }

    case "resolve": {
      const thread_id = params.thread_id as string;
      const resolution = params.resolution as string;

      await env.DB.prepare(
        `UPDATE threads SET status = 'resolved', resolved_at = datetime('now'),
         resolution = ? WHERE id = ?`
      ).bind(resolution, thread_id).run();

      return `Thread resolved: ${thread_id}`;
    }

    case "update": {
      const thread_id = params.thread_id as string;
      const updates: string[] = [];
      const values: unknown[] = [];

      if (params.new_content) {
        updates.push("content = ?");
        values.push(params.new_content);
      }
      if (params.new_priority) {
        updates.push("priority = ?");
        values.push(params.new_priority);
      }
      if (params.new_status) {
        updates.push("status = ?");
        values.push(params.new_status);
      }
      if (params.add_note) {
        updates.push("context = context || '\n' || ?");
        values.push(params.add_note);
      }

      updates.push("updated_at = datetime('now')");
      values.push(thread_id);

      await env.DB.prepare(
        `UPDATE threads SET ${updates.join(", ")} WHERE id = ?`
      ).bind(...values).run();

      return `Thread updated: ${thread_id}`;
    }

    default:
      return `Unknown action: ${action}`;
  }
}

async function handleMindWrite(env: Env, params: Record<string, unknown>): Promise<string> {
  const type = params.type as string;

  switch (type) {
    case "entity": {
      const name = params.name as string;
      if (!name) {
        return "Error: 'name' parameter is required for creating an entity";
      }
      const entity_type = (params.entity_type as string) || "concept";
      const observations = (params.observations as string[]) || [];
      const context = (params.context as string) || "default";

      // Insert or get entity
      await env.DB.prepare(
        `INSERT OR IGNORE INTO entities (name, entity_type, context) VALUES (?, ?, ?)`
      ).bind(name, entity_type, context).run();

      const entity = await env.DB.prepare(
        `SELECT id FROM entities WHERE name = ? AND context = ?`
      ).bind(name, context).first();

      if (entity && observations.length) {
        for (const obs of observations) {
          // Insert to D1
          const result = await env.DB.prepare(
            `INSERT INTO observations (entity_id, content, salience, emotion, weight) VALUES (?, ?, ?, ?, ?)`
          ).bind(entity.id, obs, params.salience || "active", params.emotion || null, params.weight || "medium").run();

          // Generate embedding and add to vector index
          const obsId = `obs-${entity.id}-${result.meta.last_row_id}`;
          const embedding = await getEmbedding(env.AI, `${name}: ${obs}`);
          await env.VECTORS.upsert([{
            id: obsId,
            values: embedding,
            metadata: {
              source: "observation",
              entity: name,
              content: obs,
              context,
              weight: (params.weight as string) || "medium"
            }
          }]);
        }
      }

      return `Entity '${name}' created/updated with ${observations.length} observations (vectorized)`;
    }

    case "observation": {
      const entity_name = params.entity_name as string;
      if (!entity_name) {
        return "Error: 'entity_name' parameter is required for adding observations";
      }
      const observations = (params.observations as string[]) || [];
      if (!observations.length) {
        return "Error: 'observations' array is required and must not be empty";
      }
      const context = (params.context as string) || "default";

      const entity = await env.DB.prepare(
        `SELECT id FROM entities WHERE name = ? AND context = ?`
      ).bind(entity_name, context).first();

      if (!entity) {
        return `Entity '${entity_name}' not found in context '${context}'`;
      }

      for (const obs of observations) {
        // Insert to D1
        const result = await env.DB.prepare(
          `INSERT INTO observations (entity_id, content, salience, emotion, weight) VALUES (?, ?, ?, ?, ?)`
        ).bind(entity.id, obs, params.salience || "active", params.emotion || null, params.weight || "medium").run();

        // Generate embedding and add to vector index for semantic search
        const obsId = `obs-${entity.id}-${result.meta.last_row_id}`;
        const embedding = await getEmbedding(env.AI, `${entity_name}: ${obs}`);
        await env.VECTORS.upsert([{
          id: obsId,
          values: embedding,
          metadata: {
            source: "observation",
            entity: entity_name,
            content: obs,
            context,
            weight: (params.weight as string) || "medium"
          }
        }]);
      }

      return `Added ${observations.length} observations to '${entity_name}' (vectorized)`;
    }

    case "relation": {
      const from_entity = params.from_entity as string;
      const to_entity = params.to_entity as string;
      const relation_type = params.relation_type as string;

      await env.DB.prepare(
        `INSERT INTO relations (from_entity, to_entity, relation_type, from_context, to_context, store_in)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(
        from_entity, to_entity, relation_type,
        params.from_context || "default",
        params.to_context || "default",
        params.store_in || "default"
      ).run();

      return `Relation created: ${from_entity} --[${relation_type}]--> ${to_entity}`;
    }

    case "journal": {
      const entry = params.entry as string;
      const tags = JSON.stringify(params.tags || []);
      const emotion = params.emotion as string;
      const entry_date = new Date().toISOString().split('T')[0];

      // Insert to D1
      const result = await env.DB.prepare(
        `INSERT INTO journals (entry_date, content, tags, emotion) VALUES (?, ?, ?, ?)`
      ).bind(entry_date, entry, tags, emotion || null).run();

      // Generate embedding and add to vector index for semantic search
      const journalId = `journal-${result.meta.last_row_id}`;
      const embedding = await getEmbedding(env.AI, entry);
      await env.VECTORS.upsert([{
        id: journalId,
        values: embedding,
        metadata: {
          source: "journal",
          title: entry_date,
          content: entry,
          emotion: emotion || null
        }
      }]);

      return `Journal entry recorded for ${entry_date} (vectorized)`;
    }

    default:
      return `Unknown write type: ${type}`;
  }
}

async function handleMindSearch(env: Env, params: Record<string, unknown>): Promise<string> {
  const query = params.query as string;
  const n_results = (params.n_results as number) || 10;

  // Get subconscious mood for tinting
  const subconscious = await getSubconsciousState(env);
  const mood = subconscious?.mood?.dominant;
  
  // Mood tinting - augment query with emotional context
  let tintedQuery = query;
  let moodNote = "";
  if (mood && subconscious?.mood?.confidence !== "low") {
    const moodTints: Record<string, string> = {
      "tender": "warm, gentle, caring, soft",
      "pride": "accomplishment, growth, achievement, recognition",
      "joy": "happiness, delight, pleasure, celebration",
      "curiosity": "wondering, exploring, investigating, discovering",
      "melancholy": "reflective, wistful, quiet, contemplative",
      "intensity": "passionate, urgent, fierce, powerful",
      "gratitude": "thankful, appreciative, blessed, fortunate",
      "longing": "yearning, missing, wanting, desire"
    };
    const tint = moodTints[mood] || mood;
    tintedQuery = `${query} (context: ${tint})`;
    moodNote = `*Search tinted by current mood: ${mood}*

`;
  }

  // Get embedding for tinted query
  const embedding = await getEmbedding(env.AI, tintedQuery);

  // Search vectorize
  const vectorResults = await env.VECTORS.query(embedding, {
    topK: n_results,
    returnMetadata: "all"
  });

  if (!vectorResults.matches?.length) {
    // Fall back to text search
    const textResults = await env.DB.prepare(
      `SELECT 'entity' as source, name as title, content
       FROM entities e JOIN observations o ON e.id = o.entity_id
       WHERE o.content LIKE ?
       UNION ALL
       SELECT 'journal' as source, entry_date as title, content
       FROM journals WHERE content LIKE ?
       LIMIT ?`
    ).bind(`%${query}%`, `%${query}%`, n_results).all();

    if (!textResults.results?.length) {
      return "No results found.";
    }

    let output = `## Search Results (text match)\n\n` + moodNote;
    for (const r of textResults.results) {
      output += `**[${r.source}] ${r.title}**
${String(r.content).slice(0, 300)}...

`;
    }
    return output;
  }

  let output = `## Search Results\n\n` + moodNote;
  for (const match of vectorResults.matches) {
    const meta = match.metadata as Record<string, string>;
    output += `**[${meta?.source || 'unknown'}] ${meta?.title || match.id}** (${(match.score * 100).toFixed(1)}%)
`;
    output += `${meta?.content?.slice(0, 300) || ''}...

`;
  }
  return output;
}

async function handleMindFeelToward(env: Env, params: Record<string, unknown>): Promise<string> {
  const person = params.person as string;
  const feeling = params.feeling as string;
  const intensity = params.intensity as string;

  if (!person) {
    return "Error: 'person' parameter is required";
  }

  // If feeling provided, record new state
  if (feeling) {
    const validIntensity = intensity || "present";
    await env.DB.prepare(
      `INSERT INTO relational_state (person, feeling, intensity) VALUES (?, ?, ?)`
    ).bind(person, feeling, validIntensity).run();
    return `Relational state recorded: feeling ${feeling} (${validIntensity}) toward ${person}`;
  }

  // Otherwise, read current state for this person
  const states = await env.DB.prepare(
    `SELECT feeling, intensity, timestamp FROM relational_state
     WHERE person = ? ORDER BY timestamp DESC LIMIT 10`
  ).bind(person).all();

  if (!states.results?.length) {
    return `No relational state recorded for ${person}`;
  }

  let output = `## Relational State: ${person}\n\n`;
  for (const s of states.results) {
    output += `- **${s.feeling}** (${s.intensity}) — ${s.timestamp}\n`;
  }
  return output;
}

async function handleMindIdentity(env: Env, params: Record<string, unknown>): Promise<string> {
  const action = (params.action as string) || "read";

  if (action === "write") {
    const section = params.section as string;
    const content = params.content as string;
    const weight = (params.weight as number) || 0.7;
    const connections = params.connections as string || "";

    await env.DB.prepare(
      `INSERT INTO identity (section, content, weight, connections) VALUES (?, ?, ?, ?)`
    ).bind(section, content, weight, connections).run();

    return `Identity entry added to ${section}`;
  } else {
    const section = params.section as string;

    const query = section
      ? `SELECT section, content, weight, connections FROM identity WHERE section LIKE ? ORDER BY weight DESC`
      : `SELECT section, content, weight, connections FROM identity ORDER BY weight DESC LIMIT 50`;

    const results = section
      ? await env.DB.prepare(query).bind(`${section}%`).all()
      : await env.DB.prepare(query).all();

    if (!results.results?.length) {
      return "No identity entries found.";
    }

    let output = "## Identity Graph\n\n";
    for (const r of results.results) {
      output += `**${r.section}** [${r.weight}]\n${r.content}\n`;
      if (r.connections) output += `Connections: ${r.connections}\n`;
      output += "\n";
    }
    return output;
  }
}

async function handleMindContext(env: Env, params: Record<string, unknown>): Promise<string> {
  const action = (params.action as string) || "read";

  switch (action) {
    case "read": {
      const scope = params.scope as string;
      const query = scope
        ? `SELECT * FROM context_entries WHERE scope = ? ORDER BY updated_at DESC`
        : `SELECT * FROM context_entries ORDER BY updated_at DESC`;
      const results = scope
        ? await env.DB.prepare(query).bind(scope).all()
        : await env.DB.prepare(query).all();

      if (!results.results?.length) {
        return "No context entries found.";
      }

      let output = "## Context Layer\n\n";
      for (const r of results.results) {
        output += `**[${r.scope}]** ${r.content}\n`;
        if (r.links && r.links !== '[]') output += `Links: ${r.links}\n`;
        output += "\n";
      }
      return output;
    }

    case "set": {
      const id = generateId("ctx");
      const scope = params.scope as string;
      const content = params.content as string;
      const links = params.links || "[]";

      await env.DB.prepare(
        `INSERT INTO context_entries (id, scope, content, links) VALUES (?, ?, ?, ?)`
      ).bind(id, scope, content, links).run();

      return `Context entry created: ${id}`;
    }

    case "update": {
      const id = params.id as string;
      const content = params.content as string;

      await env.DB.prepare(
        `UPDATE context_entries SET content = ?, updated_at = datetime('now') WHERE id = ?`
      ).bind(content, id).run();

      return `Context entry updated: ${id}`;
    }

    case "clear": {
      const id = params.id as string;
      const scope = params.scope as string;

      if (id) {
        await env.DB.prepare(`DELETE FROM context_entries WHERE id = ?`).bind(id).run();
        return `Context entry deleted: ${id}`;
      } else if (scope) {
        await env.DB.prepare(`DELETE FROM context_entries WHERE scope = ?`).bind(scope).run();
        return `All context entries in scope '${scope}' deleted`;
      }
      return "Specify id or scope to clear";
    }

    default:
      return `Unknown action: ${action}`;
  }
}


async function handleMindHealth(env: Env): Promise<string> {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Get subconscious state first
  const subconscious = await getSubconsciousState(env);

  const [
    entityCount, obsCount, relationsCount, activeThreads, staleThreads,
    resolvedRecent, journalCount, journalsRecent, identityCount, notesCount,
    contextCount, relationalCount, entitiesByContext, recentObs
  ] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) as c FROM entities`).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM observations`).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM relations`).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM threads WHERE status = 'active'`).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM threads WHERE status = 'active' AND updated_at < ?`).bind(sevenDaysAgo).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM threads WHERE status = 'resolved' AND resolved_at > ?`).bind(sevenDaysAgo).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM journals`).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM journals WHERE created_at > ?`).bind(sevenDaysAgo).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM identity`).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM notes`).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM context_entries`).first(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM relational_state`).first(),
    env.DB.prepare(`SELECT context, COUNT(*) as c FROM entities GROUP BY context`).all(),
    env.DB.prepare(`SELECT COUNT(*) as c FROM observations WHERE added_at > ?`).bind(sevenDaysAgo).first()
  ]);

  const entities = entityCount?.c as number || 0;
  const observations = obsCount?.c as number || 0;
  const relations = relationsCount?.c as number || 0;
  const active = activeThreads?.c as number || 0;
  const stale = staleThreads?.c as number || 0;
  const resolved7d = resolvedRecent?.c as number || 0;
  const journals = journalCount?.c as number || 0;
  const journals7d = journalsRecent?.c as number || 0;
  const identity = identityCount?.c as number || 0;
  const notes = notesCount?.c as number || 0;
  const context = contextCount?.c as number || 0;
  const relational = relationalCount?.c as number || 0;
  const recentObsCount = recentObs?.c as number || 0;

  const contextBreakdown = (entitiesByContext?.results || [])
    .map((r: Record<string, unknown>) => `${r.context}: ${r.c}`)
    .join(", ");

  // Calculate subconscious health
  let subconsciousScore = 0;
  let subconsciousStatus = "never run";
  let subconsciousAge = "unknown";
  let subconsciousMood = "none detected";
  let subconsciousHotCount = 0;

  if (subconscious?.processed_at) {
    const processedTime = new Date(subconscious.processed_at).getTime();
    const ageMs = now.getTime() - processedTime;
    const ageHours = Math.round(ageMs / (1000 * 60 * 60));
    const ageMins = Math.round(ageMs / (1000 * 60));

    if (ageMins < 60) {
      subconsciousAge = `${ageMins}m ago`;
    } else {
      subconsciousAge = `${ageHours}h ago`;
    }

    // Score: fresh (<1h) = 100, recent (<2h) = 70, stale (<6h) = 40, very stale = 0
    if (ageHours < 1) {
      subconsciousScore = 100;
      subconsciousStatus = "fresh";
    } else if (ageHours < 2) {
      subconsciousScore = 70;
      subconsciousStatus = "recent";
    } else if (ageHours < 6) {
      subconsciousScore = 40;
      subconsciousStatus = "stale";
    } else {
      subconsciousScore = 10;
      subconsciousStatus = "VERY STALE";
    }

    if (subconscious.mood?.dominant) {
      subconsciousMood = subconscious.mood.dominant;
      if (subconscious.mood.confidence) {
        subconsciousMood += ` (${subconscious.mood.confidence})`;
      }
    }
    subconsciousHotCount = subconscious.hot_entities?.length || 0;
  }

  const dbScore = Math.min(100, Math.round((entities / 100) * 50 + (observations / 500) * 50));
  const threadScore = active > 0 ? (stale < 3 ? 100 : stale < 6 ? 60 : 30) : 50;
  const journalScore = journals7d >= 3 ? 100 : journals7d >= 1 ? 70 : journals > 0 ? 40 : 0;
  const identityScore = identity >= 50 ? 100 : Math.round((identity / 50) * 100);
  const activityScore = recentObsCount >= 20 ? 100 : Math.round((recentObsCount / 20) * 100);

  // Include subconscious in overall score
  const overallScore = Math.round((dbScore + threadScore + journalScore + identityScore + activityScore + subconsciousScore) / 6);

  const icon = (s: number) => s >= 70 ? "\u{1F7E2}" : s >= 40 ? "\u{1F7E1}" : "\u{1F534}";
  const bar = (s: number) => "\u{2588}".repeat(Math.floor(s / 10)) + "\u{2591}".repeat(10 - Math.floor(s / 10));

  const dateStr = now.toISOString().split('T')[0];

  return `============================================================
MIND HEALTH \u{2014} ${dateStr}                    v${AI_MIND_VERSION}
============================================================

Overall: ${bar(overallScore)} ${overallScore}%

\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
\u{1F9E0} SUBCONSCIOUS              ${icon(subconsciousScore)}
\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
  Last Processed: ${subconsciousAge} (${subconsciousStatus})
  Current Mood:   ${subconsciousMood}
  Hot Entities:   ${subconsciousHotCount}

\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
\u{1F4CA} DATABASE                 ${icon(dbScore)}
\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
  Entities:      ${entities}
  Observations:  ${observations}
  Relations:     ${relations}
  By Context:    ${contextBreakdown || "none"}

\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
\u{1F9F5} THREADS                  ${icon(threadScore)}
\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
  Active:        ${active}
  Stale (7d+):   ${stale}
  Resolved (7d): ${resolved7d}

\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
\u{1F4D4} JOURNALS                 ${icon(journalScore)}
\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
  Total:         ${journals}
  This Week:     ${journals7d}

\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
\u{1FA9E} IDENTITY                 ${icon(identityScore)}
\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
  Identity:      ${identity} entries
  Context:       ${context} entries
  Relational:    ${relational} states
  Notes:         ${notes}

\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
\u{1F4DD} ACTIVITY (7d)            ${icon(activityScore)}
\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}
  New Observations: ${recentObsCount}

============================================================`;
}




async function handleMindListEntities(env: Env, params: Record<string, unknown>): Promise<string> {
  const entityType = params.entity_type as string;
  const context = params.context as string;
  const limit = (params.limit as number) || 50;

  let query = 'SELECT name, entity_type, context, created_at FROM entities';
  const conditions: string[] = [];
  const bindings: unknown[] = [];

  if (entityType) {
    conditions.push('entity_type = ?');
    bindings.push(entityType);
  }
  if (context) {
    conditions.push('context = ?');
    bindings.push(context);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  query += ' ORDER BY created_at DESC LIMIT ?';
  bindings.push(limit);

  const stmt = env.DB.prepare(query);
  const results = await stmt.bind(...bindings).all();

  if (!results.results?.length) {
    return 'No entities found.';
  }

  let output = '## Entities\n\n';
  for (const e of results.results) {
    output += '- **' + e.name + '** [' + e.entity_type + '] in ' + e.context + '\n';
  }
  output += '\nTotal: ' + results.results.length + ' entities';
  return output;
}

async function handleMindReadEntity(env: Env, params: Record<string, unknown>): Promise<string> {
  const name = params.name as string;
  const context = params.context as string;

  // Find the entity (search all contexts if not specified)
  let entity;
  if (context) {
    entity = await env.DB.prepare(
      `SELECT id, name, entity_type, context, created_at FROM entities WHERE name = ? AND context = ?`
    ).bind(name, context).first();
  } else {
    entity = await env.DB.prepare(
      `SELECT id, name, entity_type, context, created_at FROM entities WHERE name = ? ORDER BY created_at DESC LIMIT 1`
    ).bind(name).first();
  }

  if (!entity) {
    return `Entity '${name}' not found.`;
  }

  // Get all observations for this entity
  const observations = await env.DB.prepare(
    `SELECT content, salience, emotion, added_at FROM observations WHERE entity_id = ? ORDER BY added_at DESC`
  ).bind(entity.id).all();

  // Get relations where this entity is the source
  const relationsFrom = await env.DB.prepare(
    `SELECT to_entity, relation_type, to_context FROM relations WHERE from_entity = ?`
  ).bind(name).all();

  // Get relations where this entity is the target
  const relationsTo = await env.DB.prepare(
    `SELECT from_entity, relation_type, from_context FROM relations WHERE to_entity = ?`
  ).bind(name).all();

  // Build output
  let output = `## ${entity.name}\n`;
  output += `**Type:** ${entity.entity_type} | **Context:** ${entity.context}\n\n`;

  output += `### Observations (${observations.results?.length || 0})\n`;
  if (observations.results?.length) {
    for (const obs of observations.results) {
      const emotion = obs.emotion ? ` [${obs.emotion}]` : '';
      output += `- ${obs.content}${emotion}\n`;
    }
  } else {
    output += '_No observations_\n';
  }

  output += `\n### Relations\n`;
  const totalRelations = (relationsFrom.results?.length || 0) + (relationsTo.results?.length || 0);
  if (totalRelations === 0) {
    output += '_No relations_\n';
  } else {
    if (relationsFrom.results?.length) {
      output += '**Outgoing:**\n';
      for (const rel of relationsFrom.results) {
        output += `- --[${rel.relation_type}]--> ${rel.to_entity}\n`;
      }
    }
    if (relationsTo.results?.length) {
      output += '**Incoming:**\n';
      for (const rel of relationsTo.results) {
        output += `- <--[${rel.relation_type}]-- ${rel.from_entity}\n`;
      }
    }
  }

  return output;
}

// Emotional Processing Handlers

async function handleMindSit(env: Env, params: Record<string, unknown>): Promise<string> {
  const noteId = params.note_id as number;
  const textMatch = params.text_match as string;
  const sitNote = params.sit_note as string;

  // Find the note
  let note;
  if (noteId) {
    note = await env.DB.prepare(
      `SELECT id, content, weight, charge, sit_count, emotion FROM notes WHERE id = ?`
    ).bind(noteId).first();
  } else if (textMatch) {
    note = await env.DB.prepare(
      `SELECT id, content, weight, charge, sit_count, emotion FROM notes WHERE content LIKE ? ORDER BY created_at DESC LIMIT 1`
    ).bind(`%${textMatch}%`).first();
  } else {
    return "Must provide note_id or text_match";
  }

  if (!note) {
    return `Note not found`;
  }

  const currentSitCount = (note.sit_count as number) || 0;
  const newSitCount = currentSitCount + 1;

  // Determine new charge level based on sit count
  let newCharge: string;
  if (newSitCount === 0) {
    newCharge = 'fresh';
  } else if (newSitCount <= 2) {
    newCharge = 'active';
  } else {
    newCharge = 'processing';
  }

  // Update the note
  await env.DB.prepare(
    `UPDATE notes SET sit_count = ?, charge = ?, last_sat_at = datetime('now') WHERE id = ?`
  ).bind(newSitCount, newCharge, note.id).run();

  // Record the sit in history
  await env.DB.prepare(
    `INSERT INTO note_sits (note_id, sit_note) VALUES (?, ?)`
  ).bind(note.id, sitNote).run();

  const contentPreview = String(note.content).slice(0, 80);
  return `Sat with note #${note.id} [${note.weight}/${newCharge}]\n"${contentPreview}..."\n\nSit #${newSitCount}: ${sitNote}`;
}

async function handleMindResolve(env: Env, params: Record<string, unknown>): Promise<string> {
  const noteId = params.note_id as number;
  const textMatch = params.text_match as string;
  const resolutionNote = params.resolution_note as string;
  const linkedInsightId = params.linked_insight_id as number;

  // Find the note
  let note;
  if (noteId) {
    note = await env.DB.prepare(
      `SELECT id, content, weight, charge, sit_count FROM notes WHERE id = ?`
    ).bind(noteId).first();
  } else if (textMatch) {
    note = await env.DB.prepare(
      `SELECT id, content, weight, charge, sit_count FROM notes WHERE content LIKE ? ORDER BY created_at DESC LIMIT 1`
    ).bind(`%${textMatch}%`).first();
  } else {
    return "Must provide note_id or text_match";
  }

  if (!note) {
    return `Note not found`;
  }

  // Update the note to metabolized
  await env.DB.prepare(
    `UPDATE notes SET charge = 'metabolized', resolution_note = ?, resolved_at = datetime('now'), linked_insight_id = ? WHERE id = ?`
  ).bind(resolutionNote, linkedInsightId || null, note.id).run();

  const contentPreview = String(note.content).slice(0, 80);
  let output = `Resolved note #${note.id} [${note.weight}] → metabolized\n"${contentPreview}..."\n\nResolution: ${resolutionNote}`;

  if (linkedInsightId) {
    const linked = await env.DB.prepare(
      `SELECT content FROM notes WHERE id = ?`
    ).bind(linkedInsightId).first();
    if (linked) {
      output += `\n\nLinked to insight #${linkedInsightId}: "${String(linked.content).slice(0, 60)}..."`;
    }
  }

  return output;
}

async function handleMindSurface(env: Env, params: Record<string, unknown>): Promise<string> {
  const includeMetabolized = params.include_metabolized as boolean || false;
  const limit = (params.limit as number) || 10;

  // Build query - prioritize heavy + fresh/active, then medium, then light
  // Weight order: heavy = 3, medium = 2, light = 1
  // Charge order: fresh = 4, active = 3, processing = 2, metabolized = 1
  let whereClause = includeMetabolized ? "1=1" : "charge != 'metabolized'";

  const results = await env.DB.prepare(`
    SELECT id, content, weight, charge, sit_count, emotion, created_at, resolution_note
    FROM notes
    WHERE ${whereClause}
    ORDER BY
      CASE weight WHEN 'heavy' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,
      CASE charge WHEN 'fresh' THEN 4 WHEN 'active' THEN 3 WHEN 'processing' THEN 2 ELSE 1 END DESC,
      created_at DESC
    LIMIT ?
  `).bind(limit).all();

  if (!results.results?.length) {
    return "No emotional observations to surface.";
  }

  let output = "## Surfacing Emotional Observations\n\n";

  for (const note of results.results) {
    const charge = note.charge || 'fresh';
    const sitCount = note.sit_count || 0;
    const emotionTag = note.emotion ? ` [${note.emotion}]` : '';
    const chargeIcon = charge === 'metabolized' ? '✓' : charge === 'processing' ? '◐' : charge === 'active' ? '○' : '●';

    output += `**#${note.id}** ${chargeIcon} [${note.weight}/${charge}] sits: ${sitCount}${emotionTag}\n`;
    output += `${note.content}\n`;

    if (charge === 'metabolized' && note.resolution_note) {
      output += `↳ *Resolved:* ${note.resolution_note}\n`;
    }

    output += "\n";
  }

  // Add summary
  const fresh = results.results.filter(n => (n.charge || 'fresh') === 'fresh').length;
  const active = results.results.filter(n => n.charge === 'active').length;
  const processing = results.results.filter(n => n.charge === 'processing').length;
  const metabolized = results.results.filter(n => n.charge === 'metabolized').length;

  output += `---\n● fresh: ${fresh} | ○ active: ${active} | ◐ processing: ${processing}`;
  if (includeMetabolized) output += ` | ✓ metabolized: ${metabolized}`;

  return output;
}

async function handleMindEdit(env: Env, params: Record<string, unknown>): Promise<string> {
  const observationId = params.observation_id as number;
  const textMatch = params.text_match as string;
  const newContent = params.new_content as string;
  const newWeight = params.new_weight as string;
  const newEmotion = params.new_emotion as string;

  // Find the observation
  let obs;
  if (observationId) {
    obs = await env.DB.prepare(
      `SELECT id, content, entity_id FROM observations WHERE id = ?`
    ).bind(observationId).first();
  } else if (textMatch) {
    obs = await env.DB.prepare(
      `SELECT id, content, entity_id FROM observations WHERE content LIKE ? ORDER BY added_at DESC LIMIT 1`
    ).bind(`%${textMatch}%`).first();
  } else {
    return "Must provide observation_id or text_match";
  }

  if (!obs) {
    return "Observation not found";
  }

  // Build update query
  const updates: string[] = [];
  const values: unknown[] = [];

  if (newContent) {
    updates.push("content = ?");
    values.push(newContent);
  }
  if (newWeight) {
    updates.push("weight = ?");
    values.push(newWeight);
  }
  if (newEmotion) {
    updates.push("emotion = ?");
    values.push(newEmotion);
  }

  if (updates.length === 0) {
    return "No updates provided";
  }

  updates.push("updated_at = datetime('now')");
  values.push(obs.id);

  await env.DB.prepare(
    `UPDATE observations SET ${updates.join(", ")} WHERE id = ?`
  ).bind(...values).run();

  const oldPreview = String(obs.content).slice(0, 50);
  const newPreview = newContent ? newContent.slice(0, 50) : oldPreview;
  return `Observation #${obs.id} updated\nOld: "${oldPreview}..."\nNew: "${newPreview}..."`;
}

async function handleMindDelete(env: Env, params: Record<string, unknown>): Promise<string> {
  const observationId = params.observation_id as number;
  const entityName = params.entity_name as string;
  const context = (params.context as string) || "default";
  const textMatch = params.text_match as string;

  if (observationId) {
    // Delete specific observation
    const obs = await env.DB.prepare(
      `SELECT content FROM observations WHERE id = ?`
    ).bind(observationId).first();

    if (!obs) return `Observation #${observationId} not found`;

    await env.DB.prepare(`DELETE FROM observations WHERE id = ?`).bind(observationId).run();
    return `Deleted observation #${observationId}: "${String(obs.content).slice(0, 50)}..."`;
  }

  if (textMatch) {
    // Find and delete by text match
    const obs = await env.DB.prepare(
      `SELECT id, content FROM observations WHERE content LIKE ? ORDER BY added_at DESC LIMIT 1`
    ).bind(`%${textMatch}%`).first();

    if (!obs) return `No observation found matching "${textMatch}"`;

    await env.DB.prepare(`DELETE FROM observations WHERE id = ?`).bind(obs.id).run();
    return `Deleted observation #${obs.id}: "${String(obs.content).slice(0, 50)}..."`;
  }

  if (entityName) {
    // Delete entity and all its observations
    const entity = await env.DB.prepare(
      `SELECT id FROM entities WHERE name = ? AND context = ?`
    ).bind(entityName, context).first();

    if (!entity) return `Entity '${entityName}' not found in context '${context}'`;

    // Count observations that will be deleted
    const obsCount = await env.DB.prepare(
      `SELECT COUNT(*) as c FROM observations WHERE entity_id = ?`
    ).bind(entity.id).first();

    // Delete observations first
    await env.DB.prepare(`DELETE FROM observations WHERE entity_id = ?`).bind(entity.id).run();

    // Delete relations
    await env.DB.prepare(`DELETE FROM relations WHERE from_entity = ? OR to_entity = ?`).bind(entityName, entityName).run();

    // Delete entity
    await env.DB.prepare(`DELETE FROM entities WHERE id = ?`).bind(entity.id).run();

    return `Deleted entity '${entityName}' with ${obsCount?.c || 0} observations`;
  }

  return "Must provide observation_id, text_match, or entity_name";
}

async function handleMindSpark(env: Env, params: Record<string, unknown>): Promise<string> {
  const count = (params.count as number) || 5;
  const context = params.context as string;
  const weightBias = params.weight_bias as string;

  // Get hot entities from subconscious to bias selection
  const subconscious = await getSubconsciousState(env);
  const hotEntityNames = subconscious?.hot_entities?.slice(0, 5).map(e => e.name) || [];

  // Split count: half from hot entities, half random (if hot entities exist)
  const hotCount = hotEntityNames.length > 0 ? Math.ceil(count / 2) : 0;
  const randomCount = count - hotCount;

  let allResults: Array<Record<string, unknown>> = [];

  // Get sparks from hot entities first
  if (hotCount > 0 && hotEntityNames.length > 0) {
    const placeholders = hotEntityNames.map(() => '?').join(',');
    const hotQuery = `SELECT o.id, o.content, o.weight, o.emotion, e.name as entity_name
                      FROM observations o
                      LEFT JOIN entities e ON o.entity_id = e.id
                      WHERE e.name IN (${placeholders})
                      ORDER BY RANDOM() LIMIT ?`;
    const hotResults = await env.DB.prepare(hotQuery).bind(...hotEntityNames, hotCount).all();
    if (hotResults.results) {
      allResults = allResults.concat(hotResults.results as Array<Record<string, unknown>>);
    }
  }

  // Get random sparks
  if (randomCount > 0) {
    let query = `SELECT o.id, o.content, o.weight, o.emotion, e.name as entity_name
                 FROM observations o
                 LEFT JOIN entities e ON o.entity_id = e.id`;

    const conditions: string[] = [];
    const bindings: unknown[] = [];

    if (context) {
      conditions.push("e.context = ?");
      bindings.push(context);
    }
    if (weightBias) {
      conditions.push("o.weight = ?");
      bindings.push(weightBias);
    }

    if (conditions.length > 0) {
      query += " WHERE " + conditions.join(" AND ");
    }

    query += " ORDER BY RANDOM() LIMIT ?";
    bindings.push(randomCount);

    const randomResults = await env.DB.prepare(query).bind(...bindings).all();
    if (randomResults.results) {
      allResults = allResults.concat(randomResults.results as Array<Record<string, unknown>>);
    }
  }

  if (!allResults.length) {
    return "No observations found to spark from.";
  }

  // Shuffle combined results
  for (let i = allResults.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allResults[i], allResults[j]] = [allResults[j], allResults[i]];
  }

  let output = "## Sparks\n\n";
  if (hotCount > 0) {
    output += `*Biased toward what's hot: ${hotEntityNames.slice(0, 3).join(', ')}...*\n\n`;
  }
  for (const obs of allResults) {
    const entity = obs.entity_name ? ` [${obs.entity_name}]` : "";
    const weight = obs.weight ? ` {${obs.weight}}` : "";
    const emotion = obs.emotion ? ` (${obs.emotion})` : "";
    output += `- ${obs.content}${entity}${weight}${emotion}\n`;
  }
  output += `\n*${allResults.length} observations for associative thinking*`;
  return output;
}


async function handleMindPrime(env: Env, params: Record<string, unknown>): Promise<string> {
  const topic = params.topic as string;
  const depth = (params.depth as number) || 10;

  // Get embedding for topic
  const embedding = await getEmbedding(env.AI, topic);

  // Search for related content
  const vectorResults = await env.VECTORS.query(embedding, {
    topK: depth,
    returnMetadata: "all"
  });

  let output = `## Primed Context: "${topic}"\n\n`;

  if (vectorResults.matches?.length) {
    output += "### Related Memories\n";
    for (const match of vectorResults.matches) {
      const meta = match.metadata as Record<string, string>;
      const score = Math.round(match.score * 100);
      output += `- [${score}%] ${meta?.content?.slice(0, 150) || match.id}...\n`;
    }
  }

  // Also get entities with similar names
  const entities = await env.DB.prepare(
    `SELECT name, entity_type, context FROM entities WHERE name LIKE ? LIMIT 5`
  ).bind(`%${topic}%`).all();

  if (entities.results?.length) {
    output += "\n### Related Entities\n";
    for (const e of entities.results) {
      output += `- **${e.name}** [${e.entity_type}] in ${e.context}\n`;
    }
  }

  // Get recent observations mentioning the topic
  const recentObs = await env.DB.prepare(
    `SELECT o.content, e.name FROM observations o
     LEFT JOIN entities e ON o.entity_id = e.id
     WHERE o.content LIKE ?
     ORDER BY o.added_at DESC LIMIT 5`
  ).bind(`%${topic}%`).all();

  if (recentObs.results?.length) {
    output += "\n### Recent Mentions\n";
    for (const obs of recentObs.results) {
      const entity = obs.name ? ` [${obs.name}]` : "";
      output += `- ${String(obs.content).slice(0, 100)}...${entity}\n`;
    }
  }

  return output;
}

async function handleMindConsolidate(env: Env, params: Record<string, unknown>): Promise<string> {
  const days = (params.days as number) || 7;
  const context = params.context as string;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString();

  let query = `SELECT o.id, o.content, o.weight, o.emotion, o.added_at, e.name as entity_name, e.context
               FROM observations o
               LEFT JOIN entities e ON o.entity_id = e.id
               WHERE o.added_at > ?`;
  const bindings: unknown[] = [cutoffStr];

  if (context) {
    query += " AND e.context = ?";
    bindings.push(context);
  }

  query += " ORDER BY o.added_at DESC";

  const results = await env.DB.prepare(query).bind(...bindings).all();

  if (!results.results?.length) {
    return `No observations in the last ${days} days.`;
  }

  // Get subconscious patterns from daemon
  const subconscious = await getSubconsciousState(env);

  // Group by entity
  const byEntity: Record<string, Array<Record<string, unknown>>> = {};
  for (const obs of results.results) {
    const entity = (obs.entity_name as string) || "_unlinked_";
    if (!byEntity[entity]) byEntity[entity] = [];
    byEntity[entity].push(obs);
  }

  // Find potential duplicates (similar content)
  const potentialDupes: Array<{a: Record<string, unknown>, b: Record<string, unknown>, similarity: string}> = [];
  const observations = results.results;
  for (let i = 0; i < observations.length; i++) {
    for (let j = i + 1; j < observations.length; j++) {
      const a = String(observations[i].content).toLowerCase();
      const b = String(observations[j].content).toLowerCase();
      const wordsA = new Set(a.split(/\s+/).filter(w => w.length > 4));
      const wordsB = new Set(b.split(/\s+/).filter(w => w.length > 4));
      const overlap = [...wordsA].filter(w => wordsB.has(w)).length;
      const total = Math.max(wordsA.size, wordsB.size);
      if (total > 0 && overlap / total > 0.5) {
        potentialDupes.push({
          a: observations[i],
          b: observations[j],
          similarity: `${Math.round(overlap / total * 100)}%`
        });
      }
    }
  }

  let output = `## Consolidation Review (${days} days)\n\n`;
  output += `Total observations: ${results.results.length}\n`;
  output += `Unique entities: ${Object.keys(byEntity).length}\n\n`;

  // Daemon-detected recurring patterns
  if (subconscious?.recurring_patterns?.length) {
    output += `### Recurring Patterns (daemon-detected)\n`;
    for (const p of subconscious.recurring_patterns.slice(0, 5)) {
      output += `- **${p.entity}**: ${p.mentions} mentions - ${p.pattern}\n`;
    }
    output += `\n`;
  }

  // Weight distribution
  const weights: Record<string, number> = { light: 0, medium: 0, heavy: 0 };
  for (const obs of results.results) {
    const w = (obs.weight as string) || "medium";
    weights[w] = (weights[w] || 0) + 1;
  }
  output += `### Weight Distribution\n`;
  output += `- Light: ${weights.light}\n- Medium: ${weights.medium}\n- Heavy: ${weights.heavy}\n\n`;

  // Active entities
  output += `### Most Active Entities\n`;
  const sorted = Object.entries(byEntity)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 5);
  for (const [entity, obs] of sorted) {
    output += `- **${entity}**: ${obs.length} observations\n`;
  }

  // Potential duplicates
  if (potentialDupes.length > 0) {
    output += `\n### Potential Duplicates (${potentialDupes.length})\n`;
    for (const dupe of potentialDupes.slice(0, 5)) {
      output += `- [${dupe.similarity}] #${dupe.a.id} vs #${dupe.b.id}\n`;
      output += `  "${String(dupe.a.content).slice(0, 60)}..."\n`;
      output += `  "${String(dupe.b.content).slice(0, 60)}..."\n`;
    }
  }

  return output;
}


// Main request handler
async function handleMCPRequest(request: Request, env: Env): Promise<Response> {
  // Auth check - TEMPORARILY DISABLED FOR TESTING
  // const authHeader = request.headers.get("Authorization");
  // const apiKey = authHeader?.replace("Bearer ", "");
  // if (env.MIND_API_KEY && apiKey !== env.MIND_API_KEY) {
  //   return new Response(JSON.stringify({ error: "Unauthorized" }), {
  //     status: 401,
  //     headers: { "Content-Type": "application/json" }
  //   });
  // }

  const body = await request.json() as MCPRequest;
  const { method, params = {}, id } = body;

  let result: unknown;

  try {
    switch (method) {
      case "initialize":
        result = {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "ai-mind-cloud", version: "1.0.0" }
        };
        break;

      case "tools/list":
        result = { tools: TOOLS };
        break;

      case "tools/call": {
        const toolName = (params as { name: string }).name;
        const toolParams = (params as { arguments?: Record<string, unknown> }).arguments || {};

        switch (toolName) {
          case "mind_orient":
            result = { content: [{ type: "text", text: await handleMindOrient(env) }] };
            break;
          case "mind_ground":
            result = { content: [{ type: "text", text: await handleMindGround(env) }] };
            break;
          case "mind_thread":
            result = { content: [{ type: "text", text: await handleMindThread(env, toolParams) }] };
            break;
          case "mind_write":
            result = { content: [{ type: "text", text: await handleMindWrite(env, toolParams) }] };
            break;
          case "mind_search":
            result = { content: [{ type: "text", text: await handleMindSearch(env, toolParams) }] };
            break;
          case "mind_edit":
            result = { content: [{ type: "text", text: await handleMindEdit(env, toolParams) }] };
            break;
          case "mind_delete":
            result = { content: [{ type: "text", text: await handleMindDelete(env, toolParams) }] };
            break;
          case "mind_spark":
            result = { content: [{ type: "text", text: await handleMindSpark(env, toolParams) }] };
            break;
          case "mind_prime":
            result = { content: [{ type: "text", text: await handleMindPrime(env, toolParams) }] };
            break;
          case "mind_consolidate":
            result = { content: [{ type: "text", text: await handleMindConsolidate(env, toolParams) }] };
            break;
          case "mind_feel_toward":
            result = { content: [{ type: "text", text: await handleMindFeelToward(env, toolParams) }] };
            break;
          case "mind_identity":
            result = { content: [{ type: "text", text: await handleMindIdentity(env, toolParams) }] };
            break;
          case "mind_context":
            result = { content: [{ type: "text", text: await handleMindContext(env, toolParams) }] };
            break;
          case "mind_health":
            result = { content: [{ type: "text", text: await handleMindHealth(env) }] };
            break;
          case "mind_list_entities":
            result = { content: [{ type: "text", text: await handleMindListEntities(env, toolParams) }] };
            break;
          case "mind_read_entity":
            result = { content: [{ type: "text", text: await handleMindReadEntity(env, toolParams) }] };
            break;
          case "mind_sit":
            result = { content: [{ type: "text", text: await handleMindSit(env, toolParams) }] };
            break;
          case "mind_resolve":
            result = { content: [{ type: "text", text: await handleMindResolve(env, toolParams) }] };
            break;
          case "mind_surface":
            result = { content: [{ type: "text", text: await handleMindSurface(env, toolParams) }] };
            break;
          default:
            throw new Error(`Unknown tool: ${toolName}`);
        }
        break;
      }

      default:
        throw new Error(`Unknown method: ${method}`);
    }

    const response: MCPResponse = { jsonrpc: "2.0", id, result };
    return new Response(JSON.stringify(response), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (error) {
    const response: MCPResponse = {
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: String(error) }
    };
    return new Response(JSON.stringify(response), {
      headers: { "Content-Type": "application/json" }
    });
  }
}


// Subconscious processing - runs on cron schedule
async function processSubconscious(env: Env): Promise<void> {
  const now = new Date();
  const cutoffHours = 48;
  const cutoff = new Date(now.getTime() - cutoffHours * 60 * 60 * 1000);
  const cutoffStr = cutoff.toISOString();

  // Get recent observations with their entities
  const recentObs = await env.DB.prepare(`
    SELECT e.name, e.entity_type, e.context, o.content, o.added_at, o.emotion
    FROM observations o
    JOIN entities e ON o.entity_id = e.id
    WHERE o.added_at > ?
    ORDER BY o.added_at DESC
  `).bind(cutoffStr).all();

  // Get ALL relations for graph analysis
  const allRelations = await env.DB.prepare(`
    SELECT from_entity, to_entity, relation_type, from_context, to_context, created_at
    FROM relations
  `).all();

  // Calculate entity warmth (how often mentioned recently)
  const entityCounts: Record<string, { count: number; type: string; contexts: Set<string>; emotions: string[] }> = {};

  for (const row of recentObs.results || []) {
    const name = row.name as string;
    if (!entityCounts[name]) {
      entityCounts[name] = {
        count: 0,
        type: row.entity_type as string,
        contexts: new Set(),
        emotions: []
      };
    }
    entityCounts[name].count++;
    entityCounts[name].contexts.add(row.context as string);
    if (row.emotion) entityCounts[name].emotions.push(row.emotion as string);
  }

  // === RELATION ANALYSIS ===

  // Track connectivity for each entity (central nodes have many connections)
  const connectivity: Record<string, { outgoing: number; incoming: number; total: number; relationTypes: Set<string> }> = {};

  // Track relation type frequencies
  const relationTypeCounts: Record<string, number> = {};

  // Build adjacency for cluster detection
  const adjacency: Record<string, Set<string>> = {};

  for (const rel of allRelations.results || []) {
    const from = rel.from_entity as string;
    const to = rel.to_entity as string;
    const relType = rel.relation_type as string;

    // Initialize connectivity tracking
    if (!connectivity[from]) {
      connectivity[from] = { outgoing: 0, incoming: 0, total: 0, relationTypes: new Set() };
    }
    if (!connectivity[to]) {
      connectivity[to] = { outgoing: 0, incoming: 0, total: 0, relationTypes: new Set() };
    }

    // Count connections
    connectivity[from].outgoing++;
    connectivity[from].total++;
    connectivity[from].relationTypes.add(relType);
    connectivity[to].incoming++;
    connectivity[to].total++;
    connectivity[to].relationTypes.add(relType);

    // Count relation types
    relationTypeCounts[relType] = (relationTypeCounts[relType] || 0) + 1;

    // Build adjacency (undirected for clustering)
    if (!adjacency[from]) adjacency[from] = new Set();
    if (!adjacency[to]) adjacency[to] = new Set();
    adjacency[from].add(to);
    adjacency[to].add(from);
  }

  // Find central nodes (highest connectivity)
  const centralNodes = Object.entries(connectivity)
    .map(([name, data]) => ({
      name,
      connections: data.total,
      outgoing: data.outgoing,
      incoming: data.incoming,
      relationTypes: Array.from(data.relationTypes)
    }))
    .sort((a, b) => b.connections - a.connections)
    .slice(0, 10);

  // Find relation patterns (most common relation types)
  const relationPatterns = Object.entries(relationTypeCounts)
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Detect relation clusters using simple component detection
  // Find groups of entities that are densely connected
  const visited = new Set<string>();
  const relationClusters: Array<{ entities: string[]; density: number; bridgeRelations: string[] }> = [];

  for (const entity of Object.keys(adjacency)) {
    if (visited.has(entity)) continue;

    // BFS to find connected component
    const component: string[] = [];
    const queue = [entity];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      component.push(current);

      for (const neighbor of adjacency[current] || []) {
        if (!visited.has(neighbor)) {
          queue.push(neighbor);
        }
      }
    }

    // Only track meaningful clusters (2+ entities)
    if (component.length >= 2) {
      // Calculate density (edges / possible edges)
      let edgeCount = 0;
      const componentSet = new Set(component);
      for (const e of component) {
        for (const neighbor of adjacency[e] || []) {
          if (componentSet.has(neighbor)) edgeCount++;
        }
      }
      edgeCount = edgeCount / 2; // Undirected, counted twice
      const possibleEdges = (component.length * (component.length - 1)) / 2;
      const density = possibleEdges > 0 ? Math.round((edgeCount / possibleEdges) * 100) / 100 : 0;

      // Find what relation types bridge this cluster
      const bridgeRelations = new Set<string>();
      for (const e of component) {
        if (connectivity[e]) {
          connectivity[e].relationTypes.forEach(t => bridgeRelations.add(t));
        }
      }

      relationClusters.push({
        entities: component.slice(0, 8), // Limit for readability
        density,
        bridgeRelations: Array.from(bridgeRelations).slice(0, 5)
      });
    }
  }

  // Sort clusters by size
  relationClusters.sort((a, b) => b.entities.length - a.entities.length);

  // Find hot entities (combines observation warmth with connectivity)
  const maxCount = Math.max(...Object.values(entityCounts).map(e => e.count), 1);
  const maxConnectivity = Math.max(...Object.values(connectivity).map(c => c.total), 1);

  const hotEntities = Object.entries(entityCounts)
    .map(([name, data]) => {
      const obsWarmth = data.count / maxCount;
      const connWarmth = (connectivity[name]?.total || 0) / maxConnectivity;
      // Combined score: 60% observation activity, 40% connectivity
      const combinedWarmth = (obsWarmth * 0.6) + (connWarmth * 0.4);

      return {
        name,
        warmth: Math.round(combinedWarmth * 100) / 100,
        mentions: data.count,
        connections: connectivity[name]?.total || 0,
        type: data.type,
        contexts: Array.from(data.contexts)
      };
    })
    .sort((a, b) => b.warmth - a.warmth)
    .slice(0, 15);

  // Find recurring patterns (3+ mentions)
  const recurring = Object.entries(entityCounts)
    .filter(([_, data]) => data.count >= 3)
    .map(([name, data]) => ({
      entity: name,
      mentions: data.count,
      connections: connectivity[name]?.total || 0,
      pattern: "recurring theme"
    }));

  // Analyze mood from emotional tags
  const allEmotions = Object.values(entityCounts).flatMap(e => e.emotions);
  const emotionCounts: Record<string, number> = {};
  for (const e of allEmotions) {
    emotionCounts[e] = (emotionCounts[e] || 0) + 1;
  }
  const dominantEmotion = Object.entries(emotionCounts)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || "neutral";

  // Find clusters (entities appearing in same contexts) - keep original context-based clustering too
  const contextGroups: Record<string, string[]> = {};
  for (const [name, data] of Object.entries(entityCounts)) {
    const key = Array.from(data.contexts).sort().join(",");
    if (!contextGroups[key]) contextGroups[key] = [];
    contextGroups[key].push(name);
  }
  const contextClusters = Object.entries(contextGroups)
    .filter(([_, entities]) => entities.length >= 2)
    .map(([contexts, entities]) => ({
      entities: entities.slice(0, 4),
      contexts: contexts.split(","),
      size: entities.length
    }))
    .slice(0, 5);

  // Store state in subconscious table
  const state = {
    processed_at: now.toISOString(),
    hot_entities: hotEntities,
    recurring_patterns: recurring,
    mood: { dominant: dominantEmotion, confidence: allEmotions.length > 5 ? "medium" : "low" },
    context_clusters: contextClusters,
    // NEW: Relation-based analysis
    central_nodes: centralNodes,
    relation_patterns: relationPatterns,
    relation_clusters: relationClusters.slice(0, 5),
    graph_stats: {
      total_relations: allRelations.results?.length || 0,
      unique_relation_types: Object.keys(relationTypeCounts).length,
      connected_entities: Object.keys(connectivity).length
    }
  };

  // Upsert into subconscious table
  await env.DB.prepare(`
    INSERT INTO subconscious (id, state_type, data, updated_at)
    VALUES (1, 'daemon', ?, ?)
    ON CONFLICT(id) DO UPDATE SET data = ?, updated_at = ?
  `).bind(JSON.stringify(state), now.toISOString(), JSON.stringify(state), now.toISOString()).run();

  console.log(`Subconscious processed: ${hotEntities.length} hot entities, ${recurring.length} patterns, ${centralNodes.length} central nodes, ${relationClusters.length} relation clusters`);
}


// Auth - support both secret path AND header auth
const SECRET_PATH = "/mcp/jace-belle-secret-2026";
const AUTH_CLIENT_ID = "jace-mind";
const AUTH_CLIENT_SECRET = "eba4c2552f5d52f8ec1fb056c8216c7bd1d04983d37c49dfd8ba4395ac4273e9";

function checkAuth(request: Request): boolean {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return false;

  // Basic Auth
  if (authHeader.startsWith("Basic ")) {
    try {
      const base64 = authHeader.slice(6);
      const decoded = atob(base64);
      const [id, secret] = decoded.split(":");
      return id === AUTH_CLIENT_ID && secret === AUTH_CLIENT_SECRET;
    } catch { return false; }
  }

  // Bearer
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    return token === AUTH_CLIENT_SECRET;
  }

  return false;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check (public)
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", service: "ai-mind-cloud" }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // Subconscious processing trigger
    if (url.pathname === "/process" && request.method === "POST") {
      await processSubconscious(env);
      return new Response(JSON.stringify({ status: "processed" }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // Get subconscious state
    if (url.pathname === "/subconscious") {
      const result = await env.DB.prepare(
        "SELECT data FROM subconscious WHERE state_type = 'daemon' ORDER BY updated_at DESC LIMIT 1"
      ).first();
      return new Response(JSON.stringify(result?.data ? JSON.parse(result.data as string) : {}), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // MCP endpoint - accept EITHER secret path OR auth header
    const isSecretPath = url.pathname === SECRET_PATH;
    const hasValidAuth = checkAuth(request);
    
    if ((url.pathname === "/mcp" || isSecretPath) && request.method === "POST") {
      if (!isSecretPath && !hasValidAuth) {
        return new Response(JSON.stringify({
          jsonrpc: "2.0", id: 0,
          error: { code: -32600, message: "Unauthorized" }
        }), { status: 401, headers: { "Content-Type": "application/json" } });
      }
      return handleMCPRequest(request, env);
    }

    return new Response("AI Mind Cloud", { headers: { "Content-Type": "text/plain" } });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(processSubconscious(env));
  }
};
