/**
 * Quick smoke-test for the AL parser.
 * Run with:  node test-parser.mjs
 * (uses the compiled dist/extension.js bundle indirectly via the TypeScript
 *  source compiled on-the-fly through ts-node would be ideal, but here we
 *  call the webpack bundle directly using Node's require trick)
 *
 * Actually we'll just run it via tsx / ts-node.
 * Simpler: copy-paste the core logic here.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';

// ── Inline the parser (mirrors src/parser/alFileParser.ts) ─────────────────

const RE_TABLE = new RegExp(
  `^[\\uFEFF]?table\\s+(\\d+)\\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\\s*\\{?\\s*$`,
  'i'
);
const RE_TABLE_EXT = new RegExp(
  `^[\\uFEFF]?tableextension\\s+(\\d+)\\s+` +
  `(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\\s+extends\\s+` +
  `(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\\s*\\{?\\s*$`,
  'i'
);
const RE_FIELD   = /^\s*field\s*\(\s*(\d+)\s*;\s*"?([^";)]+?)"?\s*;\s*([^)]+?)\s*\)/i;
const RE_TR      = /TableRelation\s*=/i;

function netBraces(raw) {
  let depth = 0, i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (c === '/' && raw[i+1] === '/') break;
    if (c === "'") { i++; while (i < raw.length && raw[i] !== "'") i++; }
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  return depth;
}

function parseALFile(content, filePath) {
  const src   = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
  const lines = src.split(/\r?\n/);
  const tables = [], extensions = [];
  let currentTable = null, currentExtension = null, braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw  = lines[i];
    const line = raw.trim();
    braceDepth += netBraces(raw);
    if (!line || line.startsWith('//')) continue;

    if (braceDepth === 0) {
      currentTable = null;
      currentExtension = null;
    }

    if (!currentTable && !currentExtension) {
      const tm = RE_TABLE.exec(line);
      if (tm) {
        currentTable = { id: +tm[1], name: (tm[2] ?? tm[3]).trim(), filePath, fields: [] };
        tables.push(currentTable);
        continue;
      }
      const em = RE_TABLE_EXT.exec(line);
      if (em) {
        currentExtension = { baseName: (em[4] ?? em[5] ?? '').trim(), filePath };
        extensions.push(currentExtension);
        continue;
      }
      continue;
    }

    const fm = RE_FIELD.exec(raw);
    if (fm && currentTable) {
      currentTable.fields.push({ id: +fm[1], name: fm[2].trim(), dataType: fm[3].trim() });
    }
  }
  return { tables, extensions };
}

// ── Walk the AL test project ────────────────────────────────────────────────

const TEST_DIR = 'C:\\Users\\StevenRenders\\Dropbox\\__WORK\\GitHub\\AL Demos\\CHICKENMNGT\\ChickenManagement v3 - (documents)';

function walkAL(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files.push(...walkAL(full));
    else if (extname(name).toLowerCase() === '.al') files.push(full);
  }
  return files;
}

let totalTables = 0, totalExtensions = 0;
for (const fp of walkAL(TEST_DIR)) {
  const content = readFileSync(fp, 'utf8');
  const { tables, extensions } = parseALFile(content, fp);
  if (tables.length || extensions.length) {
    const shortName = fp.replace(TEST_DIR, '');
    if (tables.length)     console.log(`TABLE: ${tables.map(t => `"${t.name}" (${t.fields.length} fields)`).join(', ')}  [${shortName}]`);
    if (extensions.length) console.log(`EXT:   ${extensions.map(e => `→"${e.baseName}"`).join(', ')}  [${shortName}]`);
    totalTables += tables.length;
    totalExtensions += extensions.length;
  }
}
function stripRelParts(raw) {
  let s = raw.replace(/\s*;[\s\S]*$/, '').trim();
  s = s.replace(/\bwhere\s*\((?:[^()]*|\([^)]*\))*\)/gi, '');
  s = s.replace(/\bfilter\s*\((?:[^()]*|\([^)]*\))*\)/gi, '');
  s = s.replace(/(?:else\s+if|if)\s*\((?:[^()]*|\([^)]*\))*\)/gi, '');
  s = s.replace(/\belse\b/gi, ' ');
  return s;
}

const KEYWORDS = new Set(['if','else','then','const','filter','where','field','and','or','not','true','false']);
const TARGET_RE = /(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))(?:\s*\.\s*(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*)))?/g;

function parseRelations(content, tables) {
  const src   = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
  const lines = src.split(/\r?\n/);
  const rels = [];
  let currentTableName = null, currentFieldName = null, braceDepth = 0;
  let collecting = false, buffer = [];

  const flush = () => {
    if (!collecting || !currentFieldName || !currentTableName) { collecting = false; buffer = []; return; }
    collecting = false;
    const combined = buffer.join(' ');
    const eq = combined.indexOf('=');
    if (eq === -1) { buffer = []; return; }
    const stripped = stripRelParts(combined.slice(eq + 1));
    TARGET_RE.lastIndex = 0;
    let m;
    while ((m = TARGET_RE.exec(stripped)) !== null) {
      const tgt = (m[1] ?? m[2] ?? '').trim();
      if (!tgt || KEYWORDS.has(tgt.toLowerCase())) continue;
      if (!m[1] && tgt.length < 2) continue;
      rels.push({ from: currentTableName, field: currentFieldName, to: tgt });
    }
    buffer = [];
  };

  for (const raw of lines) {
    const line = raw.trim();
    braceDepth += netBraces(raw);
    if (!line || line.startsWith('//')) continue;

    if (braceDepth === 0) {
      flush();
      currentTableName = null; currentFieldName = null;
      const tm = RE_TABLE.exec(line);
      if (tm) { currentTableName = (tm[2] ?? tm[3]).trim(); continue; }
      continue;
    }
    if (!currentTableName) continue;

    const fm = RE_FIELD.exec(raw);
    if (fm) { flush(); currentFieldName = fm[2].trim(); continue; }

    if (currentFieldName && RE_TR.test(line)) {
      flush(); collecting = true; buffer = [line];
      if (line.includes(';')) flush();
      continue;
    }
    if (collecting) { buffer.push(line); if (line.includes(';')) flush(); }
  }
  flush();
  return rels;
}

console.log('\n--- Relations ---');
for (const fp of walkAL(TEST_DIR)) {
  const content = readFileSync(fp, 'utf8');
  const { tables } = parseALFile(content, fp);
  const rels = parseRelations(content, tables);
  for (const r of rels) {
    console.log(`  ${r.from}.${r.field}  →  ${r.to}`);
  }
}
