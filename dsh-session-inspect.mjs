// Inspect a DSH session transcript (zstd-compressed JSONL).
// usage: node dsh-session-inspect.mjs <path to session.v4.jsonl.zstd> [--grep <regex>] [--full <n>]
import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';

const file = process.argv[2];
const grepIdx = process.argv.indexOf('--grep');
const pattern = grepIdx > 0 ? new RegExp(process.argv[grepIdx + 1], 'i') : null;
const fullIdx = process.argv.indexOf('--full');
const fullN = fullIdx > 0 ? Number(process.argv[fullIdx + 1]) : 0;

const text = zstdDecompressSync(readFileSync(file)).toString('utf8');
const lines = text.split('\n').filter((l) => l.trim());
console.log('== file:', file);
console.log('== decompressed chars:', text.length, '| lines:', lines.length);

const rows = [];
for (const [i, line] of lines.entries()) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    console.log(`[${i}] <non-json>`, line.slice(0, 200));
    continue;
  }
  rows.push(obj);
  if (pattern) {
    if (pattern.test(line)) {
      const m = line.match(pattern);
      const at = Math.max(0, (m?.index ?? 0) - 200);
      console.log(`[${i}] MATCH ${JSON.stringify(line.slice(at, at + 600))}`);
    }
    continue;
  }
  const keys = Object.keys(obj).join(',');
  const compact = JSON.stringify(obj);
  console.log(`[${i}] keys=${keys} len=${compact.length} :: ${compact.slice(0, 200)}`);
}
if (fullN > 0) {
  for (let i = 0; i < Math.min(fullN, rows.length); i++) {
    console.log(`===== FULL [${i}] =====`);
    console.log(JSON.stringify(rows[i], null, 1).slice(0, 20000));
  }
}
