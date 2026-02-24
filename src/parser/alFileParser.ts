import { ALField, ALRelation, ALTable } from '../model/types';

export interface ParsedALFile {
  tables: ALTable[];
  extensions: ALTableExtension[];
  /** All table relations from table bodies in this file (excludes extension relations) */
  relations: ALRelation[];
}

export interface ALTableExtension {
  baseName: string;
  filePath: string;
  declarationLine: number;
  extraFields: ALField[];
  extraRelations: ALRelation[];
}

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

// table 18 "Customer" {  or  table 18 Customer  or  table 18 "Customer"
// Unquoted names may NOT contain spaces (AL rule), so cap at word-boundary
const RE_TABLE = new RegExp(
  `^[\\uFEFF]?table\\s+(\\d+)\\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\\s*\\{?\\s*$`,
  'i'
);
// tableextension 50100 "Ext" extends "Base Table" {  (names may be quoted or unquoted)
// Groups: 1=id, 2=quoted-ext-name, 3=unquoted-ext-name, 4=quoted-base, 5=unquoted-base
const RE_TABLE_EXT = new RegExp(
  `^[\\uFEFF]?tableextension\\s+(\\d+)\\s+` +
  `(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\\s+extends\\s+` +
  `(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\\s*\\{?\\s*$`,
  'i'
);
// field(18; "No."; Code[20])  or  field(1; SomeField; Integer)
const RE_FIELD = /^\s*field\s*\(\s*(\d+)\s*;\s*"?([^";)]+?)"?\s*;\s*([^)]+?)\s*\)/i;
// TableRelation = (any content)
const RE_TABLE_RELATION_START = /TableRelation\s*=/i;
// key(PK; "No.", "Date")  or  key(MyKey; FieldName)
const RE_KEY_DEF = /^\s*key\s*\([^;]+;\s*([^)]+)\)/i;
/** Parse a comma-separated list of (possibly quoted) AL field names */
function parseKeyFieldList(raw: string): string[] {
  const out: string[] = [];
  const re = /"([^"]+)"|([A-Za-z_][A-Za-z0-9_ .]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    out.push((m[1] ?? m[2]).trim());
  }
  return out;
}

// ---------------------------------------------------------------------------
// Count brace nesting from a raw AL line, correctly ignoring:
//   - // line comments
//   - 'single-quoted string literals'
//
// This correctness is critical: a `{` or `}` inside a comment or a string
// literal must NOT change the computed depth, otherwise the parser loses
// track of which block it is in and misattributes lines.
// ---------------------------------------------------------------------------
function netBraces(raw: string): number {
  let depth = 0;
  let i = 0;
  const len = raw.length;
  while (i < len) {
    const c = raw[i];
    if (c === '/' && raw[i + 1] === '/') {
      break; // rest of line is a comment
    }
    if (c === '\'') {
      // skip single-quoted string (AL string literals use single quotes)
      i++;
      while (i < len && raw[i] !== '\'') {
        if (raw[i] === '\\') { i++; } // escape (rare in AL but safe)
        i++;
      }
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
    }
    i++;
  }
  return depth;
}

// ---------------------------------------------------------------------------
// Relation value parser
// ---------------------------------------------------------------------------

/**
 * Given the raw text after "TableRelation =", extract all target table/field pairs.
 *
 * Handles:
 *   "Table Name"           — quoted table
 *   "Table Name"."Field"   — quoted table + quoted field
 *   "Table Name".Field     — quoted table + unquoted field
 *   TableName              — unquoted table
 *   TableName."Field"      — unquoted table + quoted field
 *   TableName.Field        — both unquoted
 *   IF (...) TableName ELSE IF (...) OtherTable   — conditional
 *   ... WHERE (...)        — filter clause (stripped)
 */
function parseRelationTargets(
  raw: string,
  sourceTable: string,
  sourceField: string
): ALRelation[] {
  // Strip everything from the terminating semicolon onward
  let s = raw.replace(/\s*;[\s\S]*$/, '').trim();

  // Strip WHERE/FILTER clauses — "WHERE ( ... )" at the end of a target reference
  // Handle one level of nested parens: WHERE (x = CONST(y))
  s = s.replace(/\bwhere\s*\((?:[^()]*|\([^)]*\))*\)/gi, '');
  s = s.replace(/\bfilter\s*\((?:[^()]*|\([^)]*\))*\)/gi, '');

  // Strip IF/ELSE IF condition blocks: IF ( condition ) → leave only the table ref
  s = s.replace(/(?:else\s+if|if)\s*\((?:[^()]*|\([^)]*\))*\)/gi, '');
  s = s.replace(/\belse\b/gi, ' ');

  const results: ALRelation[] = [];

  // AL identifier (quoted or unquoted single-word — spaces only in quoted form)
  // Quoted:   "Some Name With Spaces" or "No."
  // Unquoted: Customer  (letters/digits only, no spaces)
  const TARGET_RE =
    /(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\s*(?:\.\s*(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*)))?/g;

  // AL keywords that should never be treated as table names
  const KEYWORDS = new Set([
    'if', 'else', 'then', 'const', 'filter', 'where', 'field',
    'and', 'or', 'not', 'true', 'false'
  ]);

  let match: RegExpExecArray | null;
  while ((match = TARGET_RE.exec(s)) !== null) {
    // match[1] = quoted table, match[2] = unquoted table
    // match[3] = quoted field,  match[4] = unquoted field
    const tgtTable = (match[1] ?? match[2]).trim();
    const tgtField = (match[3] ?? match[4] ?? '').trim();

    if (KEYWORDS.has(tgtTable.toLowerCase())) { continue; }
    // Skip single-char hits (leftover punctuation)
    if (!match[1] && tgtTable.length < 2) { continue; }

    results.push({
      sourceTable,
      sourceField,
      targetTable: tgtTable,
      targetField: tgtField,
      isConditional: results.length > 0
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

export function parseALFile(content: string, filePath: string): ParsedALFile {
  // Strip UTF-8 BOM if present
  const src = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
  const lines = src.split(/\r?\n/);
  const tables: ALTable[] = [];
  const extensions: ALTableExtension[] = [];
  const tableRelations: ALRelation[] = [];

  let currentTable: ALTable | null = null;
  let currentExtension: ALTableExtension | null = null;
  let currentFieldName: string | null = null;
  let braceDepth = 0;

  // Multi-line TableRelation collection
  let collectingRelation = false;
  let relationBuffer: string[] = [];

  // Flush the multi-line relation buffer that has been accumulated since
  // the last TableRelation keyword was seen.
  // AL allows a TableRelation value to span many lines, e.g.:
  //   TableRelation =
  //     IF (Type = CONST(Item)) Item
  //     ELSE IF (...) "G/L Account";
  // We buffer each line and parse them together once the terminating `;`
  // is found (or a new field begins, or the table block closes).
  const flushRelationBuffer = () => {
    if (!collectingRelation || !currentFieldName) {
      collectingRelation = false;
      relationBuffer = [];
      return;
    }
    collectingRelation = false;

    const combined = relationBuffer.join(' ');
    const eqIdx = combined.indexOf('=');
    if (eqIdx === -1) { relationBuffer = []; return; }
    const afterEq = combined.slice(eqIdx + 1);

    const sourceTable = currentTable?.name ?? currentExtension?.baseName ?? '';
    if (!sourceTable) { relationBuffer = []; return; }

    const rels = parseRelationTargets(afterEq, sourceTable, currentFieldName);

    if (currentExtension) {
      currentExtension.extraRelations.push(...rels);
    } else if (currentTable) {
      tableRelations.push(...rels);
    }

    relationBuffer = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const raw  = lines[i];
    const line = raw.trim();

    // Update brace depth FIRST (using the comment/string-aware counter)
    braceDepth += netBraces(raw);

    // Skip blank or pure-comment lines
    if (!line || line.startsWith('//')) { continue; }

    // ── When we return to depth 0, close out any open table/extension ──
    if (braceDepth === 0) {
      if (currentTable || currentExtension) {
        flushRelationBuffer();
        currentTable = null;
        currentExtension = null;
        currentFieldName = null;
        collectingRelation = false;
      }
      // Fall through — this line might also BE a table declaration
      // (e.g., single-line `table 1 Foo {}`, or the closing `}` is on its own
      //  line and there's nothing else here — RE_TABLE won't match `}` anyway)
    }

    // ── Table declaration (only when not already inside one) ──
    if (!currentTable && !currentExtension) {
      const tableMatch = RE_TABLE.exec(line);
      if (tableMatch) {
        // Groups: 1=id, 2=quoted name, 3=unquoted name
        currentTable = {
          id:              parseInt(tableMatch[1], 10),
          name:            (tableMatch[2] ?? tableMatch[3]).trim(),
          filePath,
          declarationLine: i + 1,
          fields:          [],
          isExternal:      false
        };
        tables.push(currentTable);
        currentFieldName = null;
        collectingRelation = false;
        continue;
      }

      const extMatch = RE_TABLE_EXT.exec(line);
      if (extMatch) {
        // Groups: 1=id, 2/3=ext name (quoted/unquoted), 4/5=base name (quoted/unquoted)
        currentExtension = {
          baseName:        (extMatch[4] ?? extMatch[5] ?? '').trim(),
          filePath,
          declarationLine: i + 1,
          extraFields:     [],
          extraRelations:  []
        };
        extensions.push(currentExtension);
        currentFieldName = null;
        collectingRelation = false;
        continue;
      }

      continue; // Not inside a table/extension, nothing to do
    }

    // ── We are inside a table or extension (braceDepth > 0) ──

    // ── Field declaration ──
    const fieldMatch = RE_FIELD.exec(raw);
    if (fieldMatch) {
      flushRelationBuffer();
      const field: ALField = {
        id:       parseInt(fieldMatch[1], 10),
        name:     fieldMatch[2].trim(),
        dataType: fieldMatch[3].trim()
      };
      currentFieldName = field.name;
      if (currentTable) {
        currentTable.fields.push(field);
      } else if (currentExtension) {
        currentExtension.extraFields.push(field);
      }
      continue;
    }

    // ── Key definition — capture PK fields from the first (clustered) key ──
    if (currentTable && !collectingRelation) {
      const keyMatch = RE_KEY_DEF.exec(line);
      if (keyMatch) {
        if (!currentTable.pkFields) {
          // First key = primary key
          currentTable.pkFields = parseKeyFieldList(keyMatch[1]);
        }
        continue;
      }
    }

    // ── TableRelation property ──
    if (currentFieldName && RE_TABLE_RELATION_START.test(line)) {
      flushRelationBuffer();
      collectingRelation = true;
      relationBuffer = [line];
      if (line.includes(';')) {
        flushRelationBuffer();
      }
      continue;
    }

    // ── Continue collecting a multi-line TableRelation ──
    if (collectingRelation) {
      relationBuffer.push(line);
      if (line.includes(';')) {
        flushRelationBuffer();
      }
      continue;
    }
  }

  // Flush any open buffer at EOF
  flushRelationBuffer();

  return { tables, extensions, relations: tableRelations };
}


