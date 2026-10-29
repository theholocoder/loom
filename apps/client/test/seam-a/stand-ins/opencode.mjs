// A scripted stand-in for the user's `opencode`, put on the Environment's
// PATH by the seam A harness. Usage: node opencode.mjs <script.json> <args...>
// The script says what it reports; every invocation is appended to
// <script.json>.log, one JSON argv per line.
//
// It fakes what Loom's detection uses: `opencode --version`, and
// `opencode serve --stdio`, which prints {"url": ...} on stdout, serves
// `GET /api/integration` behind Basic auth with OPENCODE_SERVER_PASSWORD, and
// exits when its stdin closes.
import { appendFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const [scriptPath, ...args] = process.argv.slice(2);
const script = JSON.parse(readFileSync(scriptPath, 'utf8'));
appendFileSync(`${scriptPath}.log`, JSON.stringify(args) + '\n');

if (args[0] === '--version') {
  process.stdout.write(`${script.version}\n`);
} else if (args[0] === 'serve' && args.includes('--stdio')) {
  serve();
} else {
  process.stderr.write(`opencode stand-in: unscripted command ${JSON.stringify(args)}\n`);
  process.exit(1);
}

function serve() {
  const expected = 'Basic ' + Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64');
  const server = createServer((req, res) => {
    if (req.headers.authorization !== expected) {
      res.writeHead(401).end();
      return;
    }
    if (req.method === 'GET' && req.url === '/api/integration') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: script.integrations ?? [], location: { directory: process.cwd() } }));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1', () => {
    process.stdout.write(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` }) + '\n');
  });
  process.stdin.on('end', () => process.exit(0));
  process.stdin.resume();
}
