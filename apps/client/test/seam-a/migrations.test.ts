import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { migrations } from '../../src/main/storage/migrations';

// A migration's version is its position, and a database records only how many
// have run: a shipped migration edited, moved, or with another inserted before
// it, is silently skipped or run twice by a database that has it. Each shipped
// one is frozen here by a hash of its source text at its position; appending is
// the only change that passes without touching this list. A migration is
// shipped once it is on `main`: add its hash here when it merges.
//
// The text is the function's as the test runner compiles it. A toolchain update
// that changes how it prints functions changes every hash at once, with no
// migration touched: then, and only then, freeze them again from `main`.
const shipped = [
  'd5772dfdf44ebacc', // 1
  '8b944cd54fbe1b27', // 2
  '1c4256bac1f817d9', // 3
  'c1de1b5287ea03c7', // 4
  '6ae02a9f8d1097c7', // 5
  '22d684409fb31f8b', // 6
  '4d3ce26cd1584b42', // 7
  '393d7efba07d089c', // 8
  'b10dc9fba706ff73', // 9
  '6a44359bde237b34', // 10
  '162f01d49928ab7e', // 11
  'dc1e81665aabd897', // 12
  '7b2d3e66ec16e6a8', // 13
  'f19d85e6cf467823', // 14
  '2406678bbaca2fb7', // 15
  '376c44730959ff4d', // 16
  'd611401cece25ec9', // 17
];

const hash = (migration: (typeof migrations)[number]) =>
  createHash('sha256').update(migration.toString().replaceAll('\r\n', '\n')).digest('hex').slice(0, 16);

describe('the shipped migrations', () => {
  it('are unchanged, each at its position', () => {
    const now = migrations.map(hash);

    expect(now.length).toBeGreaterThanOrEqual(shipped.length);
    shipped.forEach((frozen, i) => expect(now[i], `migration ${i + 1} was edited, moved, or has one inserted before it`).toBe(frozen));
  });
});
