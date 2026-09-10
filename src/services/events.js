// Server-Sent Events hub — pushes live updates to every open browser tab.
const clients = new Set();

export function addClient(res, user) {
  const client = { res, user, id: Math.random().toString(36).slice(2) };
  clients.add(client);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, ts: Date.now() })}\n\n`);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 25000);
  res.on('close', () => { clearInterval(ping); clients.delete(client); });
  return client;
}

export function broadcast(type, data = {}) {
  const payload = `event: ${type}\ndata: ${JSON.stringify({ ...data, ts: Date.now() })}\n\n`;
  for (const c of clients) { try { c.res.write(payload); } catch { clients.delete(c); } }
}
export const clientCount = () => clients.size;
