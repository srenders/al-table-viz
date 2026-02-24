// ---------------------------------------------------------------------------
// Data model shared between extension host and webview (must be JSON-safe)
// ---------------------------------------------------------------------------

/** A field defined in a table or table extension */
export interface ALField {
  id: number;
  name: string;
  dataType: string;
  /** True for fields merged from a table extension (set by TableGraph.mergeExtension) */
  isFromExtension?: boolean;
}

/** A TableRelation link from one field to a target table/field */
export interface ALRelation {
  /** Source table name */
  sourceTable: string;
  /** Source field name */
  sourceField: string;
  /** Target table name */
  targetTable: string;
  /** Target field name, empty string if relation points only to table */
  targetField: string;
  /** True when the relation is conditional (if/else if branches) */
  isConditional: boolean;
}

/** A table object parsed from .al source or .app symbol package */
export interface ALTable {
  /** Table object number */
  id: number;
  /** Table name (without quotes) */
  name: string;
  /** Absolute path to the .al source file; empty for external tables */
  filePath: string;
  /** 1-based line number of the table declaration */
  declarationLine: number;
  /** Fields defined directly on the table */
  fields: ALField[];
  /** Field names that form the primary key (first key definition) */
  pkFields?: string[];
  /** True for tables from .app symbol packages (no source file) */
  isExternal: boolean;
  /** Namespace from SymbolReference (e.g. 'Microsoft.Finance.GeneralLedger') — external tables only */
  namespace?: string;
}

// ---------------------------------------------------------------------------
// Messages exchanged between extension host ↔ webview
// ---------------------------------------------------------------------------

export interface GraphPayload {
  tables: ALTable[];
  relations: ALRelation[];
  focusTable: string | null;
  depth: number;
  /** Current traversal direction when a focus table is active */
  direction?: 'out' | 'in' | 'both';
  /** Layout hint sent by the extension — 'concentric' for depth=1 focus, 'dagre' otherwise */
  layout?: 'dagre' | 'concentric' | 'grid';
  /** True when the subgraph was trimmed to MAX_DIAGRAM_NODES */
  capped?: boolean;
  /** Total tables in the full uncapped subgraph (only set when capped=true) */
  totalTables?: number;
  /** Sorted list of distinct namespace prefixes (2 dot-segments) from all external tables */
  namespaces: string[];
  /** All table names in the active namespace for the sidebar list; empty = no sidebar */
  sidebarItems: string[];
}

// Messages sent from the extension to the webview
export type ExtensionMessage =
  | { type: 'setGraph'; payload: GraphPayload }
  | { type: 'setLoading'; loading: boolean }
  | { type: 'setError'; message: string };

// Messages sent from the webview to the extension
export type WebviewMessage =
  | { type: 'openFile'; filePath: string; line: number }
  | { type: 'focusTable'; tableName: string }
  | { type: 'setDepth'; depth: number }
  | { type: 'setDirection'; direction: 'out' | 'in' | 'both' }
  | { type: 'filterTables'; query: string }
  | { type: 'filterByNamespace'; namespace: string }
  | { type: 'ready' };
