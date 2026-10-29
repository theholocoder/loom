// A scripted stand-in for the user's `gh` or `glab`, put on the Environment's
// PATH by the seam A harness. Usage: node forge-cli.mjs <script.json> <args...>
// The script lists the hosts the CLI is signed in to; every invocation is
// appended to <script.json>.log, one JSON argv per line.
//
// It fakes what Loom's Forge detection uses: `auth status --hostname <host>`,
// which exits 0 when signed in to that host and 1 otherwise, as both CLIs do.
import { appendFileSync, readFileSync } from 'node:fs';

const [scriptPath, ...args] = process.argv.slice(2);
const script = JSON.parse(readFileSync(scriptPath, 'utf8'));
appendFileSync(`${scriptPath}.log`, JSON.stringify(args) + '\n');

const hostname = args[args.indexOf('--hostname') + 1];
if (args[0] === 'auth' && args[1] === 'status' && args.includes('--hostname')) {
  if (script.signedInHosts.includes(hostname)) {
    process.stdout.write(`${hostname}\n  ✓ Logged in to ${hostname} account octocat\n`);
  } else {
    process.stderr.write(`You are not logged into any accounts on ${hostname}\n`);
    process.exit(1);
  }
} else {
  process.stderr.write(`forge CLI stand-in: unscripted command ${JSON.stringify(args)}\n`);
  process.exit(1);
}
