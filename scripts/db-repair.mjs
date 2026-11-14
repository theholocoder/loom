// Repairs a dev database whose schema version says more than its tables have:
// two branches that each appended a different migration at the same position,
// run against one database, leave the second one's tables and columns missing
// ("no such column"). Migrations are numbered by position, so the database
// can't tell which of the ones it counts actually ran.
//
// This builds, in memory, the schema the database's version should give with
// this checkout's migrations, then adds whatever tables, columns and indexes
// the file lacks. It never drops or rewrites anything (a column only another
// branch knows stays), and it backs the file up first. Added columns take their
// default: a migration's data backfill isn't replayed.
//
// --set-version <n> first sets the schema version to n, for a database whose
// migrations were since replaced by fewer that give the same schema (as when a
// branch squashes its own before merging), then checks it against version n.
//
// Usage: node scripts/db-repair.mjs [path/to/loom.db] [--dry-run] [--set-version <n>]
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, platform } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'apps/client/package.json'));
const Database = require('better-sqlite3');
const { Kysely, SqliteDialect } = require('kysely');
const { migrations } = await import(join(root, 'apps/client/src/main/storage/migrations.ts'));

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const at = args.indexOf('--set-version');
const setVersion = at === -1 ? undefined : /^\d+$/.test(args[at + 1] ?? '') ? Number(args[at + 1]) : NaN;
if (Number.isNaN(setVersion) || setVersion > migrations.length) {
  console.error(`--set-version takes a schema version from 0 to ${migrations.length}, the ones this checkout knows.`);
  process.exit(1);
}
const path = args.find((a, i) => !a.startsWith('--') && (at === -1 || i !== at + 1)) ?? defaultPath();

function defaultPath() {
  if (process.env.LOOM_USER_DATA_DIR) return join(process.env.LOOM_USER_DATA_DIR, 'loom.db');
  if (platform() === 'darwin') return join(homedir(), 'Library/Application Support/@loom/client/loom.db');
  if (platform() === 'win32') return join(process.env.APPDATA ?? '', '@loom/client/loom.db');
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), '@loom/client/loom.db');
}

if (!existsSync(path)) {
  console.log(`No database at ${path}`);
  process.exit(0);
}

const target = new Database(path);
const problems = target.pragma('quick_check', { simple: false }).map((r) => Object.values(r)[0]).filter((m) => m !== 'ok');
if (problems.length) {
  console.error(`${path} is damaged (${problems.join('; ')}); not touching it.`);
  process.exit(1);
}
let version = target.pragma('user_version', { simple: true });

let backup;
async function backUp() {
  if (backup) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  backup = `${path}.bak-${stamp}`;
  await target.backup(backup);
  console.log(`  Backed up to ${backup}`);
}

if (setVersion !== undefined) {
  if (setVersion === version) {
    console.log(`${path}: schema version is already ${version}.`);
  } else if (dryRun) {
    console.log(`${path}: would set schema version ${version} to ${setVersion}; checking as if it were ${setVersion}.`);
    version = setVersion;
  } else {
    await backUp();
    target.pragma(`user_version = ${setVersion}`);
    console.log(`${path}: schema version set from ${version} to ${setVersion}.`);
    version = setVersion;
  }
}
const upto = Math.min(version, migrations.length);
console.log(`${path}: schema version ${version}; this checkout knows ${migrations.length}.`);
if (version > migrations.length) {
  console.log(`  Checking against the ${migrations.length} this checkout knows; Loom from this checkout will still refuse the newer version.`);
}

// The schema version `upto` should have, built from this checkout's migrations.
const fresh = new Database(':memory:');
const kysely = new Kysely({ dialect: new SqliteDialect({ database: fresh }) });
for (const migration of migrations.slice(0, upto)) await migration(kysely);

const objects = (db, type) =>
  new Map(db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%'`).all(type).map((r) => [r.name, r.sql]));
const quote = (name) => `"${name.replaceAll('"', '""')}"`;

const statements = [];
const unfixable = [];
const extra = [];
const targetTables = objects(target, 'table');
for (const [table, createSql] of objects(fresh, 'table')) {
  if (!targetTables.has(table)) {
    statements.push(createSql);
    continue;
  }
  const have = new Set(target.pragma(`table_xinfo(${quote(table)})`).map((c) => c.name));
  const want = fresh.pragma(`table_xinfo(${quote(table)})`);
  const keys = fresh.pragma(`foreign_key_list(${quote(table)})`);
  for (const column of want) {
    if (have.has(column.name)) continue;
    if (column.pk || (column.notnull && column.dflt_value === null)) {
      unfixable.push(`${table}.${column.name} (a primary key or NOT NULL without default can't be added in place)`);
      continue;
    }
    let def = `${quote(column.name)} ${column.type}`;
    if (column.notnull) def += ' NOT NULL';
    if (column.dflt_value !== null) def += ` DEFAULT ${column.dflt_value}`;
    const key = keys.find((k) => k.from === column.name);
    if (key) def += ` REFERENCES ${quote(key.table)}(${quote(key.to)}) ON DELETE ${key.on_delete}`;
    statements.push(`ALTER TABLE ${quote(table)} ADD COLUMN ${def}`);
  }
  const wanted = new Set(want.map((c) => c.name));
  for (const name of have) if (!wanted.has(name)) extra.push(`${table}.${name}`);
}
const targetIndexes = objects(target, 'index');
for (const [index, createSql] of objects(fresh, 'index')) {
  if (createSql && !targetIndexes.has(index)) statements.push(createSql);
}

if (extra.length) console.log(`  Left as they are (not in this checkout's schema, likely another branch's): ${extra.join(', ')}`);
if (unfixable.length) console.log(`  Can't add: ${unfixable.join('; ')}`);
if (!statements.length) {
  console.log('  Nothing missing: the schema matches its version.');
  process.exit(unfixable.length ? 1 : 0);
}
console.log('  Missing, to add:');
for (const s of statements) console.log(`    ${s.replace(/\s+/g, ' ')};`);
if (dryRun) {
  console.log('Dry run: nothing changed.');
  process.exit(0);
}

await backUp();
target.pragma('foreign_keys = OFF');
target.transaction(() => {
  for (const s of statements) target.exec(s);
})();
target.close();
console.log(`Repaired: ${statements.length} change(s). Start Loom as usual; it applies any migrations past version ${version} itself.`);
