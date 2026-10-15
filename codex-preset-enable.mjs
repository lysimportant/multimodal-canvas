// codex-preset-enable.mjs — 把 preset-standard 里的 tool-subagent-codex 行打开
//
// 背景（已核实）：
//   * profile 的 cordis.patch.yml 只能按 id 寻址「合成后条目列表」里的行；
//   * applyEntryPatches 的 buildMap 只递归 group:true 且 config 为数组的兄弟行，
//     而 tool-subagent-codex 位于 preset-standard.config.plugins（对象里的数组）→ 无法按 id 寻址；
//   * 因此必须做「profile 级 preset-standard 全量快照覆盖」（billion-context 的注释也这么说）。
//
// 本脚本只做三件事：合成基线 → 生成快照文本 → 干跑校验（--write 才落盘，且先备份）。
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const PROFILE = 'C:/Users/Sui/.dsh/profiles/desktop'
const PATCH_FILE = `${PROFILE}/cordis.patch.yml`
const SHIPPED = 'G:/deepseek-harness/apps/bundle/web-app/presets/standard.patch.yml'
const SHIPPED_REAL = 'G:/deepseek-harness/packages/bundle/web-app/presets/standard.patch.yml'
const INCLUDE = 'G:/deepseek-harness/apps/cli/node_modules/@deepseek-ai/cordis-plugin-include/lib/index.js'
const WRITE = process.argv.includes('--write')
const TARGET_ID = 'preset-standard'
const ROW_ID = 'tool-subagent-codex'

const inc = await import(pathToFileURL(INCLUDE).href)
const req = createRequire('G:/deepseek-harness/apps/cli/node_modules/@deepseek-ai/cordis-plugin-include/package.json')
const yamlMod = await import(pathToFileURL(req.resolve('js-yaml')).href)
const yaml = yamlMod.default ?? yamlMod
const { applyEntryPatches, entryListSchema } = inc
const schema = entryListSchema

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const loadPatch = (p) => {
  const data = yaml.load(readFileSync(p, 'utf8'), { schema })
  if (!Array.isArray(data)) throw new TypeError(`patch file must be a top-level array: ${p}`)
  return data
}

const manifest = readJson(`${PROFILE}/package.json`)
const bundleNames = manifest.dsh?.profile?.bundles ?? []
const roots = [`${PROFILE}/node_modules`, 'C:/Users/Sui/.dsh/profiles/node_modules', 'G:/deepseek-harness/apps/cli/node_modules']

function bundleDir(name) {
  for (const root of roots) {
    const p = `${root}/${name}/package.json`
    if (existsSync(p)) return { dir: `${root}/${name}`, pkg: readJson(p) }
  }
  throw new Error(`cannot resolve bundle ${name}`)
}

// ---- 1. 逐 bundle 收集补丁层（dsh.bundle.patch 支持字符串或数组）----
const layers = []
const layerInfo = []
for (const name of bundleNames) {
  const { dir, pkg } = bundleDir(name)
  const declared = pkg.dsh?.bundle?.patch
  if (!declared) { layerInfo.push({ name, files: [], ops: 0 }); continue }
  const files = Array.isArray(declared) ? declared : [declared]
  const ops = []
  for (const rel of files) ops.push(...loadPatch(`${dir}/${rel.replace(/^\.\//, '')}`))
  layers.push(ops)
  layerInfo.push({ name, files, ops: ops.length })
}
const userText = readFileSync(PATCH_FILE, 'utf8')
const userOps = yaml.load(userText, { schema })
if (!Array.isArray(userOps)) throw new TypeError('profile patch must be a YAML sequence')
layers.push(userOps)

console.log('=== layers ===')
for (const l of layerInfo) console.log(`  ${l.name.padEnd(40)} ops=${String(l.ops).padStart(3)}  ${Array.isArray(l.files) ? l.files.length : 0} file(s)`)

// ---- 2. 合成基线 ----
let warnings = []
const composed = applyEntryPatches([], structuredClone(layers.flat()), (m, ...a) => warnings.push([m, a]))
const preset = composed.find((e) => e.id === TARGET_ID)
if (!preset) throw new Error(`${TARGET_ID} not in composed list`)
const composedConfig = preset.config
const rows = composedConfig.plugins
console.log(`=== composed ${TARGET_ID}: config.id=${composedConfig.id} order=${composedConfig.order} top-level rows=${rows.length} ===`)
console.log(`=== warnings during baseline compose: ${warnings.length} ===`)
for (const [m, a] of warnings.slice(0, 12)) console.log('   warn:', m, ...a)

// 行可以嵌在 cordis:group 子组里（delegation 组就装着 codex 行），必须递归找
const findRow = (list, id, path = []) => {
  for (const row of list) {
    const here = [...path, row.id ?? '(no-id)']
    if (row.id === id) return { row, path: here }
    if (row.group && Array.isArray(row.config)) {
      const hit = findRow(row.config, id, here)
      if (hit) return hit
    }
  }
  return null
}
const codexHit = findRow(rows, ROW_ID)
if (!codexHit) throw new Error(`${ROW_ID} not present inside ${TARGET_ID}.config.plugins`)
const codexRow = codexHit.row
console.log(`=== ${ROW_ID}: path=${codexHit.path.join(' > ')} disabled=${JSON.stringify(codexRow.disabled)} config=${JSON.stringify(codexRow.config)} ===`)

// 递归删除某行的 disabled（用于构造期望结果）
const stripDisabled = (list, id) => list.map((row) => {
  if (row.id === id) return Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'disabled'))
  if (row.group && Array.isArray(row.config)) return { ...row, config: stripDisabled(row.config, id) }
  return row
})

// ---- 3. 与随包 shipped 文件比对，确认没有别的层动过它 ----
const shippedPath = existsSync(SHIPPED) ? SHIPPED : SHIPPED_REAL
const shippedOps = loadPatch(shippedPath)
const shippedPresetOp = shippedOps.find((op) => Array.isArray(op.insert) && op.insert.some((r) => r.id === TARGET_ID))
const shippedConfig = shippedPresetOp.insert.find((r) => r.id === TARGET_ID).config
const same = JSON.stringify(shippedConfig) === JSON.stringify(composedConfig)
console.log(`=== composed config identical to shipped ${shippedPath}: ${same} ===`)
if (!same) console.log('   (shipped != composed → 快照应从合成结果导出，而不是文本改写)')

// ---- 4. 生成全量快照文本：dedent 随包声明 + 删掉 codex 行的 disabled ----
const shippedLines = readFileSync(shippedPath, 'utf8').split(/\r?\n/)
const startIdx = shippedLines.findIndex((l) => /^\s*- id: preset-standard\s*$/.test(l))
if (startIdx < 0) throw new Error('preset-standard row not found in shipped file')
let body = shippedLines.slice(startIdx)
const dedent = Math.min(...body.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length))
// 关键：空行必须原样保留（YAML 块标量里的空行 = 段落分隔，删掉会改变字符串值）
body = body.map((l) => (l.trim() === '' ? '' : l.slice(dedent)))
while (body.length && body[body.length - 1].trim() === '') body.pop()
const rowStart = body.findIndex((l) => l.trim() === `- id: ${ROW_ID}`)
if (rowStart < 0) throw new Error(`${ROW_ID} row not found after dedent`)
let removedDisabled = null
for (let i = rowStart + 1; i < Math.min(rowStart + 8, body.length); i++) {
  if (/^\s*disabled:\s*true\s*$/.test(body[i])) { removedDisabled = body[i]; body.splice(i, 1); break }
}
if (removedDisabled === null) throw new Error('codex row had no `disabled: true` line to remove')
const snapshotText = body.join('\n')
console.log(`=== removed line: ${JSON.stringify(removedDisabled)} ===`)
const snapshotOps = yaml.load(snapshotText, { schema })
if (!Array.isArray(snapshotOps)) throw new Error('snapshot text is not a YAML sequence')
console.log(`=== snapshot parses: entries=${snapshotOps.length} ids=${snapshotOps.map((e) => e.id).join(',')} ===`)
const snapshotConfig = snapshotOps[0].config

// ---- 5. 干跑：把快照当成 user patch 的最后一层 ----
warnings = []
const after = applyEntryPatches(structuredClone(composed), structuredClone(snapshotOps), (m, ...a) => warnings.push([m, ...a]))
const afterPreset = after.find((e) => e.id === TARGET_ID)
const afterRows = afterPreset.config.plugins
const expected = JSON.stringify({ ...composedConfig, plugins: stripDisabled(rows, ROW_ID) })
const actual = JSON.stringify(afterPreset.config)
const newCodex = findRow(afterRows, ROW_ID)?.row
const firstDiff = (a, b, path = '$') => {
  if (a === b) return null
  const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)
  if (kind(a) !== kind(b)) return { path, a, b }
  if (kind(a) === 'array') {
    if (a.length !== b.length) return { path: `${path}.length`, a: a.length, b: b.length }
    for (let i = 0; i < a.length; i++) { const d = firstDiff(a[i], b[i], `${path}[${i}]`); if (d) return d }
    return null
  }
  if (kind(a) === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b)
    if (ka.join(',') !== kb.join(',')) return { path: `${path}.keys`, a: ka.join(','), b: kb.join(',') }
    for (const k of ka) { const d = firstDiff(a[k], b[k], `${path}.${k}`); if (d) return d }
    return null
  }
  return { path, a, b }
}
console.log('=== dry run ===')
console.log(`   warnings: ${warnings.length}`, ...warnings.slice(0, 8).map((w) => JSON.stringify(w)))
console.log(`   top-level rows: ${rows.length} -> ${afterRows.length}`)
console.log(`   ${ROW_ID}: disabled=${JSON.stringify(newCodex?.disabled)} (undefined 即已启用)`)
console.log(`   whole config identical except that one flag: ${expected === actual}`)
if (expected !== actual) {
  const d = firstDiff({ ...composedConfig, plugins: stripDisabled(rows, ROW_ID) }, afterPreset.config)
  console.log('   first diff:', JSON.stringify(d))
}
if (warnings.length || newCodex?.disabled !== undefined || expected !== actual || afterRows.length !== rows.length) {
  console.log('   => DRY RUN FAIL')
  console.log(`      codex before=${JSON.stringify(codexRow)}\n      codex after =${JSON.stringify(newCodex)}`)
  process.exit(3)
}
console.log('   => DRY RUN PASS')

// ---- 6. 落盘（仅 --write）----
const header = `\n# --- Codex 子智能体：profile 级 preset-standard 全量快照覆盖（由 codex-preset-enable.mjs 生成）---\n# 原因：preset-standard.config.plugins 里的行无法按 id 寻址（applyEntryPatches 只递归 group 条目），\n# 因此按 billion-context 注释所述，用「整段 config 覆盖」把 ${ROW_ID} 的 disabled: true 去掉。\n# 除该行外，其余与 @deepseek-ai/dsh-web-app 0.2.0-rc.2 的 presets/standard.patch.yml 完全一致。\n`
const stray = /^- id: tool-subagent-codex\n(?:  disabled: false\n)+/m
const cleaned = userText.replace(stray, '')
console.log(`=== stray hand-written entry removed from text: ${cleaned !== userText} ===`)
const nextText = `${cleaned.replace(/\s*$/, '')}${header}${snapshotText}\n`
// 语法复核：整份新文件的每一层都能按同一方言解析
const reparsed = yaml.load(nextText, { schema })
console.log(`=== new file parses: entries=${reparsed.length} last id=${reparsed[reparsed.length - 1].id} ===`)
if (WRITE) {
  // 运行中的 App 会实时写这份文件；落盘前确认没有被它改过，否则中止（避免覆盖它的增改）
  const fresh = readFileSync(PATCH_FILE, 'utf8')
  if (fresh !== userText) {
    console.log('=== ABORT: profile patch changed since this run read it (live app write). Re-run. ===')
    process.exit(4)
  }
  const bak = `${PATCH_FILE}.bak-${Date.now()}`
  copyFileSync(PATCH_FILE, bak)
  writeFileSync(PATCH_FILE, nextText)
  console.log(`=== written. backup: ${bak} ===`)
  const roundTrip = yaml.load(readFileSync(PATCH_FILE, 'utf8'), { schema })
  let w2 = []
  const final = applyEntryPatches([], structuredClone([...layers.slice(0, -1).flat(), ...roundTrip]), (m, ...a) => w2.push([m, ...a]))
  const fp = final.find((e) => e.id === TARGET_ID)
  const fc = findRow(fp.config.plugins, ROW_ID)?.row
  console.log(`=== post-write verify: warnings=${w2.length} rows=${fp.config.plugins.length} ${ROW_ID}.disabled=${JSON.stringify(fc?.disabled)} ===`)
} else {
  console.log('=== dry mode: nothing written (pass --write to apply) ===')
  console.log(snapshotText.split('\n').slice(0, 12).join('\n'))
  console.log('   ... (共 ' + snapshotText.split('\n').length + ' 行)')
}
