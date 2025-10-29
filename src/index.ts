export default {
  async fetch(request: Request, env: any, ctx: any) {
    const url = new URL(request.url);

    console.log(`[DEBUG] Received request for path: ${url.pathname}`);

    if (url.pathname === '/kv') {
      console.log('[DEBUG] Matching /kv route');

      // Write a key-value pair
      await env.KV.put('KEY', 'VALUE');
      console.log('[DEBUG] Wrote key-value pair: KEY=VALUE');

      // Read a key-value pair
      const value = await env.KV.get('KEY');
      console.log(`[DEBUG] Read key-value pair: KEY=${value}`);

      // List all key-value pairs
      const allKeys = await env.KV.list();
      console.log('[DEBUG] Listed all key-value pairs:', allKeys);

      // Delete a key-value pair
      await env.KV.delete('KEY');
      console.log('[DEBUG] Deleted key-value pair: KEY');

      // Return a Workers response
      return new Response(
        JSON.stringify({
          value: value,
          allKeys: allKeys,
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    console.log('[DEBUG] No matching route found');
    // Return 404 for other paths
    return new Response('Not found', { status: 404 });
  },
};