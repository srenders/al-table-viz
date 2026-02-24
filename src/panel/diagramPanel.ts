import * as vscode from 'vscode';
import { TableGraph } from '../model/tableGraph';
import { ALTable, ALRelation, GraphPayload, ExtensionMessage, WebviewMessage } from '../model/types';

/**
 * Strip fields from external tables to keep the postMessage payload small.
 * Source tables (and the focused table) keep their full field list.
 * @param keepFieldsFor  If set, that table keeps its fields even if external.
 */
function prepareFields(tables: ALTable[], keepFieldsFor?: string): ALTable[] {
  const keep = keepFieldsFor?.toLowerCase();
  return tables.map(t =>
    (!t.isExternal || t.name.toLowerCase() === keep)
      ? t
      : { ...t, fields: [] }
  );
}

/**
 * Hard cap on diagram node count.
 * The dagre layout algorithm degrades noticeably above ~80 nodes; 60 keeps
 * the initial render fast without hiding nearby context.
 * This is purely a performance guard — data accuracy is never affected.
 * The UI shows a notice when the graph was trimmed (capped=true in payload).
 */
const MAX_DIAGRAM_NODES = 60;

/**
 * Trim the subgraph to at most MAX_DIAGRAM_NODES tables.
 * The focus table is always inserted first so it is never dropped.
 * Relations are re-filtered so only edges between retained nodes remain.
 * Only called at depth >= 2; at depth=1 all direct neighbours are shown in full.
 */
function capSubgraph(
  tables: ALTable[], relations: ALRelation[],
  focusTable: string | null
): { tables: ALTable[]; relations: ALRelation[]; capped: boolean; totalTables: number } {
  const total = tables.length;
  if (total <= MAX_DIAGRAM_NODES) {
    return { tables, relations, capped: false, totalTables: total };
  }
  const focus = focusTable?.toLowerCase();
  const kept: ALTable[] = [];
  const focusRow = tables.find(t => t.name.toLowerCase() === focus);
  if (focusRow) { kept.push(focusRow); }
  for (const t of tables) {
    if (kept.length >= MAX_DIAGRAM_NODES) { break; }
    if (t.name.toLowerCase() === focus) { continue; }
    kept.push(t);
  }
  const keptNames = new Set(kept.map(t => t.name.toLowerCase()));
  const keptRels = relations.filter(
    r => keptNames.has(r.sourceTable.toLowerCase()) && keptNames.has(r.targetTable.toLowerCase())
  );
  return { tables: kept, relations: keptRels, capped: true, totalTables: total };
}

export class DiagramPanel {
  private static _instance: DiagramPanel | undefined;
  /**
   * Output channel created lazily on first use.
   * Avoids creating the channel before the extension is activated or when the
   * diagram panel is never opened.
   */
  private static _outChannel: vscode.OutputChannel | undefined;
  private static get _out(): vscode.OutputChannel {
    if (!DiagramPanel._outChannel) {
      DiagramPanel._outChannel = vscode.window.createOutputChannel('AL Table Viz – Diagram');
    }
    return DiagramPanel._outChannel;
  }

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];

  private _graph: TableGraph | null = null;
  private _focusTable: string | null = null;
  private _namespace: string | null = null;
  private _depth: number;
  private _direction: 'out' | 'in' | 'both' = 'out';

  static create(extensionUri: vscode.Uri, graph: TableGraph, focusTable?: string): DiagramPanel {
    const config = vscode.workspace.getConfiguration('alTableViz');
    const depth: number = config.get('defaultDepth', 2);

    if (DiagramPanel._instance) {
      DiagramPanel._instance._panel.reveal(vscode.ViewColumn.Beside);
      DiagramPanel._instance.update(graph, focusTable ?? null);
      return DiagramPanel._instance;
    }

    const panel = vscode.window.createWebviewPanel(
      'alTableViz',
      'AL Table Relations',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')]
      }
    );

    DiagramPanel._instance = new DiagramPanel(panel, extensionUri, depth);
    DiagramPanel._instance.update(graph, focusTable ?? null);
    return DiagramPanel._instance;
  }

  /** Returns the currently open panel instance, if any. */
  static get instance(): DiagramPanel | undefined {
    return DiagramPanel._instance;
  }

  /** Re-send the latest graph to the webview without changing focus or direction. */
  refresh(graph: TableGraph): void {
    this._graph = graph;
    this._sendGraph();
  }

  /** Send a loading indicator state to the webview. */
  postLoading(loading: boolean): void {
    this._postMessage({ type: 'setLoading', loading });
  }

  /** Send an error message to the webview. */
  postError(message: string): void {
    this._postMessage({ type: 'setError', message });
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    depth: number
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._depth = depth;

    this._panel.onDidDispose(() => this._dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => this._handleMessage(msg),
      null,
      this._disposables
    );

    this._panel.webview.html = this._getHtml();
  }

  update(graph: TableGraph, focusTable: string | null): void {
    this._graph = graph;
    this._focusTable = focusTable;
    this._sendGraph();
  }

  private _sendGraph(): void {
    if (!this._graph) {
      return;
    }

    const namespaces  = this._graph.getNamespaces();
    const sidebarItems = this._namespace
      ? this._graph.getTableNamesForNamespace(this._namespace)
      : [];
    let payload: GraphPayload;

    if (this._focusTable) {
      const sub = this._graph.getSubgraph(this._focusTable, this._depth, this._direction);
      const allRels = this._graph.getRelations();
      const ftLower = this._focusTable.toLowerCase();
      const directRels = allRels.filter(r =>
        r.sourceTable.toLowerCase() === ftLower || r.targetTable.toLowerCase() === ftLower
      );
      DiagramPanel._out.appendLine(
        `[sendGraph] focusTable="${this._focusTable}" depth=${this._depth} ` +
        `→ subgraph tables=${sub.tables.length} relations=${sub.relations.length} ` +
        `| allRelations=${allRels.length} directRels=${directRels.length}`
      );
      // Always log the first 8 direct relations so we can see what's in the graph
      DiagramPanel._out.appendLine(
        `  Direct rels (first 8): ${JSON.stringify(directRels.slice(0, 8).map(r => `${r.sourceTable}.${r.sourceField}→${r.targetTable}`))}`
      );
      // Always slim external tables (except the focused table itself keeps fields for rich display).
      // Then cap the payload size to stay well under the 2 MB postMessage limit.
      const slimmed = prepareFields(sub.tables, this._focusTable);
      // At depth=1 show ALL direct neighbours (no cap) so the slider
      // meaningfully adds nodes when increased. At depth>=2 cap to MAX_DIAGRAM_NODES.
      const capped = this._depth <= 1
        ? { tables: slimmed, relations: sub.relations, capped: false, totalTables: slimmed.length }
        : capSubgraph(slimmed, sub.relations, this._focusTable);
      payload = {
        tables: capped.tables,
        relations: capped.relations,
        capped: capped.capped,
        totalTables: capped.totalTables,
        layout: this._depth <= 1 && !!this._focusTable ? 'concentric' : 'dagre',
        direction: this._direction,
        focusTable: this._focusTable,
        depth: this._depth,
        namespaces,
        sidebarItems
      };
    } else if (this._namespace) {
      // Namespace mode with no focused table: show nothing in diagram until user picks from sidebar
      payload = {
        tables: [],
        relations: [],
        focusTable: null,
        depth: this._depth,
        namespaces,
        sidebarItems
      };
    } else {
      // Default view: source tables + their neighbours up to _depth hops.
      const sub = this._graph.getSourceSubgraph(this._depth);
      payload = {
        tables: prepareFields(sub.tables),
        relations: sub.relations,
        focusTable: null,
        depth: this._depth,
        namespaces,
        sidebarItems: []
      };
    }

    this._postMessage({ type: 'setGraph', payload });
  }

  private _postMessage(msg: ExtensionMessage): void {
    this._panel.webview.postMessage(msg);
  }

  private _handleMessage(msg: WebviewMessage): void {
    switch (msg.type) {
      case 'ready':
        this._sendGraph();
        break;

      case 'openFile':
        if (msg.filePath) {
          const uri = vscode.Uri.file(msg.filePath);
          const pos = new vscode.Position(Math.max(0, msg.line - 1), 0);
          vscode.window.showTextDocument(uri, {
            selection: new vscode.Range(pos, pos),
            viewColumn: vscode.ViewColumn.One
          });
        }
        break;

      case 'focusTable':
        this._focusTable = msg.tableName;
        this._direction = 'out'; // reset direction for each new focus
        this._sendGraph();
        break;

      case 'setDirection':
        this._direction = msg.direction;
        this._sendGraph();
        break;

      case 'setDepth':
        this._depth = msg.depth;
        this._sendGraph();
        break;

      case 'filterTables':
        if (this._graph) {
          const namespaces   = this._graph.getNamespaces();
          const sidebarItems = this._namespace ? this._graph.getTableNamesForNamespace(this._namespace) : [];
          if (!msg.query.trim()) {
            // Empty filter: re-send normal graph state
            this._sendGraph();
          } else {
            const filtered = this._graph.filterByName(msg.query);
            const payload: GraphPayload = {
              tables: prepareFields(filtered.tables),
              relations: filtered.relations,
              focusTable: null,
              depth: this._depth,
              namespaces,
              sidebarItems
            };
            this._postMessage({ type: 'setGraph', payload });
          }
        }
        break;

      case 'filterByNamespace':
        this._namespace = msg.namespace || null;
        this._focusTable = null;
        this._sendGraph();
        break;
    }
  }

  private _getHtml(): string {
    const webview = this._panel.webview;
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview.js')
    );
    // A cryptographically random nonce is embedded in both the CSP header and
    // the <script> tag. The webview sandbox executes only scripts whose nonce
    // attribute matches, blocking any injected or third-party scripts.
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             script-src 'nonce-${nonce}';
             style-src ${webview.cspSource} 'unsafe-inline';
             img-src data: ${webview.cspSource};" />
  <title>AL Table Relations</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { display: flex; flex-direction: column; height: 100vh; overflow: hidden;
           font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
           background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
    #toolbar { display: flex; align-items: center; gap: 8px; padding: 6px 10px;
               background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-panel-border);
               flex-shrink: 0; flex-wrap: wrap; }
    #toolbar label { font-size: 12px; white-space: nowrap; }
    #searchInput { flex: 1; min-width: 100px; max-width: 200px;
                   background: var(--vscode-input-background);
                   color: var(--vscode-input-foreground);
                   border: 1px solid var(--vscode-input-border, #555);
                   padding: 3px 6px; border-radius: 3px; font-size: 12px; }
    #nsFilter { background: var(--vscode-input-background);
                color: var(--vscode-input-foreground);
                border: 1px solid var(--vscode-input-border, #555);
                padding: 3px 6px; border-radius: 3px; font-size: 12px;
                max-width: 200px; }
    #depthSlider { width: 80px; }
    #depthVal { min-width: 12px; text-align: center; font-size: 12px; }
    .tb-btn { padding: 3px 10px; font-size: 12px; cursor: pointer;
              background: var(--vscode-button-background);
              color: var(--vscode-button-foreground);
              border: none; border-radius: 3px; }
    .tb-btn:hover { background: var(--vscode-button-hoverBackground); }
    #btnDirection { min-width: 70px; }
    .zoom-btn { padding: 2px 8px; font-size: 14px; line-height: 1; cursor: pointer;
                background: var(--vscode-button-secondaryBackground, #3a3a3a);
                color: var(--vscode-button-secondaryForeground, #ccc);
                border: 1px solid var(--vscode-input-border, #555); border-radius: 3px; }
    .zoom-btn:hover { background: var(--vscode-button-secondaryHoverBackground, #4a4a4a); }
    #focusCrumb { font-size: 11px; color: var(--vscode-textLink-foreground, #4a9eff);
                  display: flex; align-items: center; gap: 4px; white-space: nowrap; }
    #focusCrumb span { font-weight: bold; }
    #focusCrumb button { background: none; border: none; cursor: pointer; font-size: 13px; line-height: 1;
                        color: var(--vscode-descriptionForeground); padding: 0 2px; }
    #focusCrumb button:hover { color: var(--vscode-errorForeground); }
    #status { font-size: 11px; color: var(--vscode-descriptionForeground); margin-left: auto; white-space: nowrap; }
    /* Content area: sidebar + canvas side by side */
    #content { display: flex; flex: 1; overflow: hidden; min-height: 0; position: relative; }
    #sidebar { width: 220px; min-width: 160px; flex-shrink: 0; display: flex; flex-direction: column;
               background: var(--vscode-sideBar-background);
               border-right: 1px solid var(--vscode-panel-border); overflow: hidden; }
    #sidebarHeader { padding: 5px 10px; font-size: 11px; font-weight: bold; flex-shrink: 0;
                     color: var(--vscode-sideBarSectionHeader-foreground, #bbb);
                     background: var(--vscode-sideBarSectionHeader-background, #252526);
                     border-bottom: 1px solid var(--vscode-panel-border); }
    #sidebarSearch { margin: 5px 6px; padding: 3px 6px; font-size: 11px; flex-shrink: 0;
                     background: var(--vscode-input-background); color: var(--vscode-input-foreground);
                     border: 1px solid var(--vscode-input-border, #555); border-radius: 3px; }
    #tableList { list-style: none; overflow-y: auto; flex: 1; padding: 2px 0; }
    #tableList li { padding: 4px 12px; font-size: 11px; cursor: pointer;
                    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #tableList li:hover { background: var(--vscode-list-hoverBackground); }
    #tableList li.active { background: var(--vscode-list-activeSelectionBackground, #094771);
                           color: var(--vscode-list-activeSelectionForeground, #fff); }
    #cy { flex: 1; min-width: 0; }
    /* Context menu */
    #ctxMenu { position: fixed; z-index: 9999; display: none;
               background: var(--vscode-menu-background, #252526);
               border: 1px solid var(--vscode-menu-border, #454545); border-radius: 4px;
               padding: 4px 0; box-shadow: 2px 4px 14px rgba(0,0,0,0.6); min-width: 170px; }
    .ctx-item { padding: 6px 14px; font-size: 12px; cursor: pointer; }
    .ctx-item:hover { background: var(--vscode-menu-selectionBackground, #0e639c);
                      color: var(--vscode-menu-selectionForeground, #fff); }
    .ctx-sep  { height: 1px; background: var(--vscode-menu-border, #454545); margin: 3px 0; }
    #loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
               font-size: 14px; background: var(--vscode-editor-background); z-index: 10; }
    #errorBanner { display: flex; align-items: center; gap: 8px; padding: 8px 12px; flex-shrink: 0;
                   background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
                   color: var(--vscode-inputValidation-errorForeground, #f48771);
                   font-size: 12px; border-bottom: 1px solid var(--vscode-inputValidation-errorBorder, #be1100); }
    #errorBanner button { margin-left: auto; background: none; border: none; cursor: pointer;
                          color: inherit; font-size: 15px; line-height: 1; }
    .hidden { display: none !important; }
  </style>
</head>
<body>
  <div id="toolbar">
    <label for="searchInput">Filter:</label>
    <input id="searchInput" type="search" placeholder="Table name…" />
    <label for="nsFilter">Namespace:</label>
    <select id="nsFilter">
      <option value="">All / Source tables</option>
    </select>
    <label for="depthSlider">Depth:</label>
    <input id="depthSlider" type="range" min="1" max="5" value="2" />
    <span id="depthVal">2</span>
    <button class="tb-btn" id="btnReset">Reset</button>
    <button class="tb-btn" id="btnDirection" title="Toggle relation direction">&#x2192; Out</button>
    <div id="focusCrumb" class="hidden">Focused: <span id="crumbName"></span><button id="btnClearFocus" title="Clear focus">×</button></div>
    <button class="zoom-btn" id="btnFit" title="Fit all (F)">&#x26F6;</button>
    <button class="zoom-btn" id="btnZoomIn" title="Zoom in (+)">+</button>
    <button class="zoom-btn" id="btnZoomOut" title="Zoom out (-)">&#x2212;</button>
    <button class="tb-btn" id="btnExportPng" title="Export diagram as PNG">&#x1F4F7; PNG</button>
    <button class="tb-btn" id="btnExportSvg" title="Export diagram as SVG">&#x1F5BC; SVG</button>
    <button class="tb-btn" id="btnExportMermaid" title="Export diagram as Mermaid erDiagram">&#x1F9DC; Mermaid</button>
    <span id="status"></span>
  </div>
  <!-- Context menu -->
  <div id="ctxMenu">
    <div class="ctx-item" id="ctxFocus">&#x1F50D; Show relations</div>
    <div class="ctx-sep"></div>
    <div class="ctx-item" id="ctxOpen">&#x1F4C4; Open file</div>
  </div>
  <!-- Error banner -->
  <div id="errorBanner" class="hidden">
    <span id="errorMsg"></span>
    <button id="btnDismissError" title="Dismiss">&#x2715;</button>
  </div>
  <!-- Main content: sidebar + diagram -->
  <div id="content">
    <div id="loading">Loading diagram…</div>
    <div id="sidebar" class="hidden">
      <div id="sidebarHeader">Tables</div>
      <input id="sidebarSearch" type="search" placeholder="Search tables…" />
      <ul id="tableList"></ul>
    </div>
    <div id="cy"></div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private _dispose(): void {
    DiagramPanel._instance = undefined;
    this._panel.dispose();
    this._disposables.forEach(d => d.dispose());
    this._disposables = [];
  }
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
