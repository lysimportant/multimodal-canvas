// Summarize a DSH session projection cache JSON: structure + where key strings appear.
// usage: node dsh-proj-inspect.mjs <file.json> [needle1 needle2 ...]
import { readFileSync } from 'node:fs';

const [, , file, ...needles] = process.argv;
const data = JSON.parse(readFileSync(file, 'utf8'));

const describe = (v) => {
  if (Array.isArray(v)) return `array(${v.length})`;
  if (v === null) return 'null';
  if (typeof v === 'object') return `object{${Object.keys(v).slice(0, 12).join(',')}}`;
  if (typeof v === 'string') return `string(${v.length})`;
  return `${typeof v}:${v}`;
};

console.log('== file:', file);
for (const [k, v] of Object.entries(data)) console.log(`  ${k} = ${describe(v)}`);

// Walk and report needle hits with a short path.
const hits = [];
const walk = (node, path, depth) => {
  if (depth > 12 || hits.length > 60) return;
  if (typeof node === 'string') {
    for (const n of needles) {
      if (node.toLowerCase().includes(n.toLowerCase())) {
        const at = node.toLowerCase().indexOf(n.toLowerCase());
        hits.push(`${path} :: …${node.slice(Math.max(0, at - 90), at + 140)}…`);
        break;
      }
    }
    return;
  }
  if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1));
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`, depth + 1);
  }
};
for (const n of needles) walk(data, '', 0);
console.log('== hits:', hits.length);
for (const h of hits.slice(0, 40)) console.log('  -', h);

// If it looks like a transcript, list message roles + tool names.
const msgs = data.messages ?? data.entries ?? data.items ?? data.turns;
if (Array.isArray(msgs)) {
  console.log('== message count:', msgs.length);
  for (const [i, m] of msgs.entries()) {
    const role = m?.role ?? m?.type ?? m?.kind ?? '?';
    const textLen = typeof m?.content === 'string' ? m.content.length : JSON.stringify(m?.content ?? '').length;
    console.log(`  [${i}] role=${role} textLen=${textLen} keys=${Object.keys(m ?? {}).join(',')}`);
  }
}
