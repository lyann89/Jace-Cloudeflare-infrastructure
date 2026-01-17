export interface Env {
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  API_KEY: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    
    // Simple API key check
    const authHeader = request.headers.get('Authorization');
    const providedKey = authHeader?.replace('Bearer ', '');
    
    if (providedKey !== env.API_KEY && url.pathname !== '/health') {
      return new Response('Unauthorized', { status: 401 });
    }

    // Routes
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname === '/memories' && request.method === 'GET') {
      const results = await env.DB.prepare('SELECT * FROM memories ORDER BY created_at DESC LIMIT 50').all();
      return new Response(JSON.stringify(results), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname === '/memories' && request.method === 'POST') {
      const body = await request.json() as any;
      const id = crypto.randomUUID();
      
      await env.DB.prepare(
        'INSERT INTO memories (id, content, memory_type, emotional_weight, salience_level, metadata) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(
        id,
        body.content,
        body.memory_type || 'general',
        body.emotional_weight || 0.5,
        body.salience_level || 'active',
        JSON.stringify(body.metadata || {})
      ).run();

      return new Response(JSON.stringify({ id, success: true }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (url.pathname === '/sessions' && request.method === 'POST') {
      const body = await request.json() as any;
      const id = crypto.randomUUID();
      
      await env.DB.prepare(
        'INSERT INTO sessions (id, summary, emotional_arc, metadata) VALUES (?, ?, ?, ?)'
      ).bind(id, body.summary || '', body.emotional_arc || '', JSON.stringify(body.metadata || {})).run();

      return new Response(JSON.stringify({ id, success: true }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response('Not Found', { status: 404 });
  }
};
