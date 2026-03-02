import JSZip from 'jszip';
import { ALField, ALRelation, ALTable } from '../model/types';
import { parseALFile } from './alFileParser';

export interface AppPackageIdentity {
  publisher: string;
  name: string;
  version: string;
  id: string;
}

export interface AppPackageResult {
  tables: ALTable[];
  relations: ALRelation[];
  log: string[];
  /** Identity read from app.json inside the .app ZIP */
  appInfo?: AppPackageIdentity;
}

/**
 * Reads a compiled .app symbol package (ZIP archive) and extracts
 * table + field metadata for use as "external" tables in the diagram.
 */
export async function readAppPackage(
  content: Uint8Array,
  appFilePath = ''
): Promise<AppPackageResult> {
  const log: string[] = [];

  let zip: InstanceType<typeof JSZip>;
  try {
    zip = await JSZip.loadAsync(content);
  } catch (e) {
    return { tables: [], relations: [], log: [`Failed to open ZIP: ${e}`] };
  }

  // List all files in the package for diagnostics
  const allFiles = Object.keys(zip.files);
  log.push(`ZIP contains ${allFiles.length} entries: ${allFiles.slice(0, 20).join(', ')}${allFiles.length > 20 ? '...' : ''}`);

  // ── Read app.json for package identity (publisher / name / version / id) ────
  let appInfo: AppPackageIdentity | undefined;
  const appJsonFile = zip.file('app.json') ?? zip.file(/(?:^|\/)app\.json$/i)[0];
  if (appJsonFile) {
    try {
      const appJsonText = await appJsonFile.async('string');
      const appJsonBom = appJsonText.charCodeAt(0) === 0xFEFF ? appJsonText.slice(1) : appJsonText;
      const appMeta = JSON.parse(appJsonBom) as Record<string, unknown>;
      appInfo = {
        publisher: String(appMeta['publisher'] ?? appMeta['Publisher'] ?? '').trim(),
        name:      String(appMeta['name']      ?? appMeta['Name']      ?? '').trim(),
        version:   String(appMeta['version']   ?? appMeta['Version']   ?? '').trim(),
        id:        String(appMeta['id']        ?? appMeta['Id']        ?? '').trim()
      };
      log.push(`app.json identity: ${appInfo.publisher} / ${appInfo.name} ${appInfo.version}`);
    } catch (e) {
      log.push(`Could not read app.json: ${e}`);
    }
  }

  let symbolJson: string | null = null;
  let foundIn = '';

  // Search for SymbolReference.json at ANY depth (BC packages vary)
  const symbolFile = zip.file(/(?:^|\/)[Ss]ymbol[Rr]eference\.json$/)[0];
  if (symbolFile) {
    try {
      symbolJson = await symbolFile.async('string');
      foundIn = symbolFile.name;
    } catch (e) {
      log.push(`Failed to read ${symbolFile.name}: ${e}`);
    }
  }

  // Fallback: any .json file at any depth that contains "Tables"
  if (!symbolJson) {
    const jsonFiles = zip.file(/\.json$/i);
    for (const f of jsonFiles) {
      try {
        const text = await f.async('string');
        if (text.includes('"Tables"') || text.includes('"tables"')) {
          symbolJson = text;
          foundIn = f.name;
          break;
        }
      } catch {
        // continue
      }
    }
  }

  if (!symbolJson) {
    log.push('No symbol reference JSON found in package');
    return { tables: [], relations: [], log };
  }
  log.push(`Using symbol file: ${foundIn}`);

  let manifest: unknown;
  try {
    // Strip UTF-8 BOM if present — BC symbol files commonly start with \uFEFF
    const jsonText = symbolJson.charCodeAt(0) === 0xFEFF ? symbolJson.slice(1) : symbolJson;
    manifest = JSON.parse(jsonText);
  } catch (e) {
    log.push(`Failed to parse JSON: ${e}`);
    return { tables: [], relations: [], log };
  }

  const tableDefs = extractTableDefs(manifest, log);
  log.push(`Parsed ${tableDefs.length} table(s) from symbol reference`);

  const tables: ALTable[] = tableDefs.map(def => ({
    id: def.id,
    name: def.name,
    filePath: '',
    declarationLine: 0,
    fields: def.fields,
    pkFields: def.pkFields,
    isExternal: true,
    namespace: def.namespace || undefined,
    appFilePath: appFilePath || undefined,
    appPublisher: appInfo?.publisher || undefined,
    appName:      appInfo?.name      || undefined,
    appVersion:   appInfo?.version   || undefined,
    appId:        appInfo?.id        || undefined
  }));

  // Build relations from TableRelation properties on fields
  const relations: ALRelation[] = [];
  const relSeen = new Set<string>();
  for (const def of tableDefs) {
    for (const rel of def.relations) {
      const key = `${rel.sourceTable}||${rel.sourceField}||${rel.targetTable}`;
      if (!relSeen.has(key)) {
        relSeen.add(key);
        relations.push(rel);
      }
    }
  }
  log.push(`Parsed ${relations.length} relation(s) from symbol reference`);

  // ── Pass 2: parse *.Table.al source files in the ZIP for TableRelation data ──
  // Only needed when the SymbolReference produced 0 relations AND the ZIP
  // actually has AL source files (i.e. the BC Base App which strips
  // TableRelation from its SymbolReference.json).
  if (relations.length === 0) {
    const tableAlFiles = zip.file(/\.Table\.al$/i);
    if (tableAlFiles.length > 0) {
      log.push(`SymbolReference had no relations — scanning ${tableAlFiles.length} *.Table.al source file(s) in parallel`);

      // Decompress all files in parallel, then parse synchronously
      const texts = await Promise.all(
        tableAlFiles.map(f => f.async('string').catch(() => ''))
      );

      let alRelCount = 0;
      for (let i = 0; i < tableAlFiles.length; i++) {
        const text = texts[i];
        if (!text) { continue; }
        try {
          const parsed = parseALFile(text, tableAlFiles[i].name);
          if (parsed.tables.length === 0) { continue; }
          for (const rel of parsed.relations) {
            const key = `${rel.sourceTable.toLowerCase()}||${rel.sourceField.toLowerCase()}||${rel.targetTable.toLowerCase()}`;
            if (!relSeen.has(key)) {
              relSeen.add(key);
              relations.push(rel);
              alRelCount++;
            }
          }
        } catch { /* ignore individual parse failures */ }
      }
      log.push(`Extracted ${alRelCount} relation(s) from AL source files`);
    }
  }

  return { tables, relations, log, appInfo };
}

// ---------------------------------------------------------------------------
// Helpers to traverse different known manifest shapes
// ---------------------------------------------------------------------------

interface RawTableDef {
  id: number;
  name: string;
  namespace: string;
  fields: ALField[];
  relations: ALRelation[];
  pkFields?: string[];
}

/**
 * Resolve a TableRelation property on a raw field object to the target table
 * name, or null if the relation cannot be determined.
 *
 * BC SymbolReference shapes seen in the wild:
 *   { Object: { Name: "No. Series" }, FieldName: "Code", Conditions: [] }
 *   [ { Object: { Name: "No. Series" } }, ... ]  (conditional array — take first)
 *   { TableName: "No. Series" }
 *   { Name: "No. Series" }
 *   "No. Series"   (plain string in some older apps)
 */
function resolveTableRelation(raw: unknown): { tableName: string; fieldName: string; isConditional: boolean } | null {
  if (!raw) { return null; }

  // Plain string
  if (typeof raw === 'string' && raw.trim()) {
    return { tableName: raw.trim(), fieldName: '', isConditional: false };
  }

  // Array of conditional branches — take the first with a resolvable name
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const r = resolveTableRelation(item);
      if (r) { return { ...r, isConditional: raw.length > 1 }; }
    }
    return null;
  }

  if (typeof raw !== 'object') { return null; }
  const r = raw as Record<string, unknown>;

  // Shape 1: { Object: { Name: ... }, FieldName: ... }  — primary BC shape
  const obj = (r['Object'] ?? r['object']) as Record<string, unknown> | undefined;
  if (obj && typeof obj === 'object') {
    const tblName = String(obj['Name'] ?? obj['name'] ?? '').replace(/^"|"$/g, '').trim();
    if (tblName) {
      const fldName = String(r['FieldName'] ?? r['fieldName'] ?? '').trim();
      const conds = r['Conditions'] ?? r['conditions'];
      const isConditional = Array.isArray(conds) && conds.length > 0;
      return { tableName: tblName, fieldName: fldName, isConditional };
    }
  }

  // Shape 2: { TableName: ... }
  const tblName2 = String(r['TableName'] ?? r['tableName'] ?? '').replace(/^"|"$/g, '').trim();
  if (tblName2) {
    const fldName = String(r['FieldName'] ?? r['fieldName'] ?? '').trim();
    return { tableName: tblName2, fieldName: fldName, isConditional: false };
  }

  // Shape 3: { Name: ... } (root-level name, some ISV apps)
  const tblName3 = String(r['Name'] ?? r['name'] ?? '').replace(/^"|"$/g, '').trim();
  if (tblName3) {
    return { tableName: tblName3, fieldName: '', isConditional: false };
  }

  return null;
}

/**
 * Build a human-readable AL type string (and optional enum name) from a TypeDefinition object.
 * Returns { dataType, enumName? }.
 * e.g. { Name: "Code", Subtype: null } + length hint → { dataType: "Code[20]" }
 *      { Name: "Enum", Subtype: { Name: "Gen. Posting Type" } } → { dataType: "Enum", enumName: "Gen. Posting Type" }
 */
function resolveTypeInfo(f: Record<string, unknown>): { dataType: string; enumName?: string } {
  const td = (f['TypeDefinition'] ?? f['typeDefinition']) as Record<string, unknown> | undefined;
  if (!td) {
    return { dataType: String(f['DataType'] ?? f['dataType'] ?? f['Type'] ?? f['type'] ?? 'Unknown') };
  }
  const base = String(td['Name'] ?? td['name'] ?? 'Unknown');

  // TypeArguments carries the length for Code[n] / Text[n]
  const args = td['TypeArguments'] as unknown[] | undefined;
  if (args && args.length > 0) {
    const arg = args[0] as Record<string, unknown>;
    const len = arg['Name'] ?? arg['name'];
    if (len !== undefined) { return { dataType: `${base}[${len}]` }; }
  }

  // Some older symbol files store length directly on TypeDefinition
  const len = td['Length'] ?? td['length'];
  if (len !== undefined) { return { dataType: `${base}[${len}]` }; }

  // Enum / Record subtype name — keep dataType as the base kind, expose name separately
  const sub = td['Subtype'] as Record<string, unknown> | undefined;
  if (sub) {
    const subName = String(sub['Name'] ?? sub['name'] ?? '').trim();
    if (subName) {
      const baseLower = base.toLowerCase();
      if (baseLower === 'enum' || baseLower === 'record') {
        return { dataType: base, enumName: subName };
      }
      return { dataType: `${base}(${subName})` };
    }
  }

  return { dataType: base };
}

/**
 * Recursively collect tables from a SymbolReference container.
 * BC packages may nest tables inside Namespaces[], which have the same
 * shape as the root (Tables[], Namespaces[], …).
 * @param nsName  Dot-separated namespace path accumulated during recursion.
 */
function extractTableDefs(manifest: unknown, log: string[], depth = 0, nsName = '', _relSample?: { done: boolean }): RawTableDef[] {
  if (!manifest || typeof manifest !== 'object') { return []; }
  const m = manifest as Record<string, unknown>;
  // Top-level shared sampler so we only log one example
  const relSample = _relSample ?? { done: false };

  if (depth === 0) {
    // Log top-level keys once for diagnostics
    log.push(`Symbol root keys: ${Object.keys(m).join(', ')}`);
  }

  const rawTables = ((m['Tables'] ?? m['tables']) as unknown[] | undefined) ?? [];
  const results: RawTableDef[] = [];

  for (const raw of rawTables) {
    if (!raw || typeof raw !== 'object') { continue; }
    const t = raw as Record<string, unknown>;
    const id   = Number(t['Id']   ?? t['id']   ?? 0);
    const name = String(t['Name'] ?? t['name'] ?? '').replace(/^"|"$/g, '').trim();
    if (!name) { continue; }

    const rawFields = ((t['Fields'] ?? t['fields']) as unknown[] | undefined) ?? [];
    const fields: ALField[] = [];
    const relations: ALRelation[] = [];

    // Extract primary key field names from the Keys array (first key = PK)
    let pkFields: string[] | undefined;
    const rawKeys = ((t['Keys'] ?? t['keys']) as unknown[] | undefined) ?? [];
    if (rawKeys.length > 0) {
      const firstKey = rawKeys[0] as Record<string, unknown>;
      // SymbolReference may use FieldNames (array) or a comma-separated string
      const fn = firstKey['FieldNames'] ?? firstKey['fieldNames'] ?? firstKey['Fields'] ?? firstKey['fields'];
      if (Array.isArray(fn)) {
        pkFields = (fn as unknown[]).map(x => String((x as any)?.['Name'] ?? (x as any)?.['name'] ?? x).trim()).filter(Boolean);
      } else if (typeof fn === 'string' && fn.trim()) {
        pkFields = fn.split(',').map(s => s.trim()).filter(Boolean);
      }
    }

    for (const rf of rawFields) {
      if (!rf || typeof rf !== 'object') { continue; }
      const f = rf as Record<string, unknown>;
      const fId   = Number(f['Id']   ?? f['id']   ?? 0);
      const fName = String(f['Name'] ?? f['name'] ?? '').replace(/^"|"$/g, '').trim();
      if (!fName) { continue; }
      const typeInfo = resolveTypeInfo(f);
      const field: ALField = { id: fId, name: fName, dataType: typeInfo.dataType };
      if (typeInfo.enumName) { field.enumName = typeInfo.enumName; }
      fields.push(field);

      // Extract TableRelation if present
      const rawRel = f['TableRelation'] ?? f['tableRelation'];
      if (rawRel) {
        // Log the first raw TableRelation shape once for diagnostics
        if (!relSample.done) {
          relSample.done = true;
          try {
            log.push(`Sample TableRelation (table=${name}, field=${fName}): ${JSON.stringify(rawRel).slice(0, 300)}`);
          } catch { /* ignore */ }
        }
        const resolved = resolveTableRelation(rawRel);
        if (resolved) {
          relations.push({
            sourceTable: name,
            sourceField: fName,
            targetTable: resolved.tableName,
            targetField: resolved.fieldName,
            isConditional: resolved.isConditional
          });
        }
      }
    }

    results.push({ id, name, namespace: nsName, fields, relations, pkFields });
  }

  // Recurse into Namespaces (BC Base App and newer ISV apps use this)
  const namespaces = ((m['Namespaces'] ?? m['namespaces']) as unknown[] | undefined) ?? [];
  for (const ns of namespaces) {
    if (!ns || typeof ns !== 'object') { continue; }
    const nsObj = ns as Record<string, unknown>;
    const childName = String(nsObj['Name'] ?? nsObj['name'] ?? '').trim();
    const childNs = nsName ? `${nsName}.${childName}` : childName;
    results.push(...extractTableDefs(ns, log, depth + 1, childNs, relSample));
  }

  return results;
}
