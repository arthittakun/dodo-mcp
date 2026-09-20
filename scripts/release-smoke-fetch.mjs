/** Same-origin fixture restart can leave Node's global HTTP pool holding an
 * already-closed socket. Retry ONLY MCP initialization after that transport
 * reset. Tool calls, notifications, HTTP errors and uncertain effects are never
 * retried here. This is an installed-package test client, not server policy. */
export function restartInitializationFetch(fetchImpl = globalThis.fetch) {
  return async (input, init) => {
    let initialization = false;
    try {
      const message = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      initialization = init?.method?.toUpperCase() === 'POST' && message?.jsonrpc === '2.0'
        && message.method === 'initialize' && !Array.isArray(message);
    } catch { /* Unknown messages are never retried. */ }
    for (let attempt = 0; ; attempt++) {
      try { return await fetchImpl(input, init); }
      catch (error) {
        const code = error?.cause?.code;
        if (!initialization || attempt >= 3 || !['ECONNRESET', 'UND_ERR_SOCKET'].includes(code) || init?.signal?.aborted) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  };
}
