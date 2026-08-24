import { createServer } from 'node:http';
const mock = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  const auth = String(req.headers.authorization ?? '');
  if (req.url?.includes('/chat/completions')) {
    if (!auth.includes('sk-loop-mock')) { res.statusCode = 401; res.end(JSON.stringify({ error: 'bad' })); return; }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = JSON.parse(body || '{}');
      const userMsg = (j.messages ?? []).find((m: any) => m.role === 'user');
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: `BYOK-E2E-OK analyzed: ${String(userMsg?.content ?? '').slice(0, 30)}` } }],
        usage: { prompt_tokens: 120, completion_tokens: 45 },
      }));
    });
    return;
  }
  if (!auth.includes('sk-loop-mock')) {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: 'bad' }));
    return;
  }
  res.end(JSON.stringify({ object: 'list', data: [{ id: 'llama3.2' }] }));
});
mock.listen(0, '127.0.0.1', () => {
  const port = (mock.address() as { port: number }).port;
  console.log('MOCKPORT=' + port);
});
setTimeout(() => process.exit(0), 120000);
