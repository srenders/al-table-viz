// ---------------------------------------------------------------------------
// Data model shared between extension host and webview (must be JSON-safe)
// ---------------------------------------------------------------------------

/**
 * Resolved color palette used by the webview to render the diagram.
 * All values are CSS colour strings (hex preferred).
 * The extension resolves the active theme + custom overrides before sending;
 * the webview never reads raw settings directly.
 */
export interface DiagramColors {
  // Source-table node
  nodeHeaderBg:     string;
  nodeBodyBg:       string;
  nodeBorderColor:  string;
  nodeNameFg:       string;
  nodePkFg:         string;
  nodeFieldFg:      string;
  nodeExtFieldFg:   string;   // ⊕ extension-merged fields inside a source table
  nodeSepColor:     string;
  moresFg:          string;
  // External-table node
  extNodeHeaderBg:    string;
  extNodeBodyBg:      string;
  extNodeBorderColor: string;
  extNodeNameFg:      string;
  extNodePkFg:        string;
  extNodeFieldFg:     string;
  extNodeExtFieldFg:  string; // ⊕ extension-merged fields inside an external table
  extNodeSepColor:    string;
  // Edges
  edgeColor:      string;
  edgeLabelColor: string;
  edgeLabelBg:    string;
  edgeCondColor:  string;
  // Selection / highlight
  selectedColor:  string;
  highlightColor: string;
  // Export background
  exportBg: string;
}

/** A field defined in a table or table extension */
export interface ALField {
  id: number;
  name: string;
  dataType: string;
  /** True for fields merged from a table extension (set by TableGraph.mergeExtension) */
  isFromExtension?: boolean;
  /** For Enum fields: the human-readable enum object name (e.g. "Gen. Posting Type") */
  enumName?: string;
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
  /** Absolute path to the .app package file this table was loaded from (external tables only) */
  appFilePath?: string;
  /** Namespace from SymbolReference (e.g. 'Microsoft.Finance.GeneralLedger') — external tables only */
  namespace?: string;
  /** App package publisher, read from app.json inside the .app ZIP (external tables only) */
  appPublisher?: string;
  /** App package name, read from app.json inside the .app ZIP (external tables only) */
  appName?: string;
  /** App package version string, read from app.json inside the .app ZIP (external tables only) */
  appVersion?: string;
  /** App package GUID, read from app.json inside the .app ZIP (external tables only) */
  appId?: string;
  /** Workspace folder name this table's .al source file belongs to (source tables only) */
  sourceFolder?: string;
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
  /** Sorted list of distinct app package keys ("Publisher / Name Version") from all external tables */
  appPackages: string[];
  /** Sorted list of distinct workspace folder names from all source tables */
  sourceFolders: string[];
  /** All table names in the active namespace for the sidebar list; empty = no sidebar */
  sidebarItems: string[];
  /** Resolved colour palette for the webview to use when rendering the diagram */
  colors: DiagramColors;
  /** Name of the active colour theme ('dark' | 'light' | 'highContrast' | 'solarized' | 'custom') */
  colorTheme: string;
  /** Maximum depth the slider should allow (mirrors the schema maximum, default 10) */
  maxDepth?: number;
  /** Maximum diagram nodes setting value — shown in the capped status message */
  maxDiagramNodes?: number;
}

/**
 * A single relation entry for the relation list panel.
 * Produced by TableGraph.getRelatedEntries().
 */
export interface RelatedEntry {
  sourceTable: string;
  sourceField: string;
  targetTable: string;
  targetField: string;
  /** True when either the source or target table is external (from a .app package) */
  isExternal: boolean;
  /** BFS hop distance from the root table: 1 = direct relation, 2+ = transitive */
  hopDistance: number;
}

// Messages sent from the extension to the webview
export type ExtensionMessage =
  | { type: 'setGraph'; payload: GraphPayload }
  | { type: 'setLoading'; loading: boolean }
  | { type: 'setError'; message: string }
  | { type: 'setRelationList'; tableName: string; depth: number; direction: 'out' | 'in' | 'both'; entries: RelatedEntry[]; tableFiles: Record<string, { filePath: string; line: number }> };

// Messages sent from the webview to the extension
export type WebviewMessage =
  | { type: 'openFile'; filePath: string; line: number; tableName?: string }
  | { type: 'focusTable'; tableName: string }
  | { type: 'setDepth'; depth: number }
  | { type: 'setDirection'; direction: 'out' | 'in' | 'both' }
  | { type: 'filterTables'; query: string }
  | { type: 'filterByNamespace'; namespace: string }
  | { type: 'filterByAppPackage'; appPackage: string }
  | { type: 'filterBySourceFolder'; folder: string }
  | { type: 'findRelated'; tableName: string }
  | { type: 'syncRelated'; tableName: string }
  | { type: 'pickTable' }
  | { type: 'ready' }
  | { type: 'setTheme'; theme: string };
