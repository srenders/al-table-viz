import * as vscode from 'vscode';
import { TableGraph } from '../model/tableGraph';
import { RelatedEntry } from '../model/types';
import { openExternalTableFromZip } from './openExternal';

type RelationListMessage = {
  type: 'setRelationList';
  tableName: string;
  depth: number;
  entries: RelatedEntry[];
  tableFiles: Record<string, { filePath: string; line: number }>;
  direction: 'out' | 'in' | 'both';
};

type RelationListIncoming =
  | { type: 'focusTable'; tableName: string }
  | { type: 'openFile'; filePath: string; line: number; tableName: string };

export class RelationListPanel {
  /** Called when the user clicks a table name in the list — lets DiagramPanel focus the diagram. */
  static onFocusTableRequest: ((tableName: string) => void) | undefined;
  private static _instance: RelationListPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _graph: TableGraph | null = null;
  private _disposables: vscode.Disposable[] = [];

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  static show(
    extensionUri: vscode.Uri,
    graph: TableGraph,
    tableName: string,
    depth: number,
    direction: 'out' | 'in' | 'both' = 'both'
  ): RelationListPanel {
    if (RelationListPanel._instance) {
      // Panel is already open — just reveal and push new data via postMessage
      // (the webview script is already running so the message is received)
      RelationListPanel._instance._panel.reveal(vscode.ViewColumn.Beside);
      RelationListPanel._instance.update(graph, tableName, depth, direction);
    } else {
      // Build the initial payload first so we can embed it in the HTML
      const msg = RelationListPanel._buildMessage(graph, tableName, depth, direction);
      const panel = vscode.window.createWebviewPanel(
        'alTableVizRelList',
        'AL Table Relations List',
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')]
        }
      );
      const inst = new RelationListPanel(panel, extensionUri);
      RelationListPanel._instance = inst;
      inst._graph = graph;
      inst._panel.title = `Relations: ${tableName}`;
      // Embed initial data in the HTML — script reads it synchronously at load time,
      // avoiding any postMessage race condition on first open.
      panel.webview.html = inst._getHtml(msg);
    }
    return RelationListPanel._instance!;
  }

  static get instance(): RelationListPanel | undefined {
    return RelationListPanel._instance;
  }

  update(graph: TableGraph, tableName: string, depth: number, direction: 'out' | 'in' | 'both' = 'both'): void {
    this._graph = graph;
    this._panel.title = `Relations: ${tableName}`;
    const msg = RelationListPanel._buildMessage(graph, tableName, depth, direction);
    this._postMessage(msg);
  }

  private static _buildMessage(
    graph: TableGraph, tableName: string, depth: number, direction: 'out' | 'in' | 'both'
  ): RelationListMessage {
    const entries = graph.getRelatedEntries(tableName, depth, direction);
    const tableFiles: Record<string, { filePath: string; line: number }> = {};
    for (const t of graph.getTables()) {
      if (t.filePath) {
        tableFiles[t.name] = { filePath: t.filePath, line: t.declarationLine };
      }
    }
    return { type: 'setRelationList', tableName, depth, entries, tableFiles, direction };
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._panel.onDidDispose(() => this._dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      (msg: RelationListIncoming) => {
        if (msg.type === 'focusTable') {
          RelationListPanel.onFocusTableRequest?.(msg.tableName);
        } else if (msg.type === 'openFile') {
          if (msg.filePath) {
            const uri = vscode.Uri.file(msg.filePath);
            const pos = new vscode.Position(Math.max(0, (msg.line ?? 1) - 1), 0);
            vscode.window.showTextDocument(uri, {
              selection: new vscode.Range(pos, pos),
              viewColumn: vscode.ViewColumn.One
            });
          } else {
            // External table — extract source from the .app ZIP
            const table = this._graph?.getTables().find(
              t => t.name.toLowerCase() === msg.tableName.toLowerCase()
            );
            void openExternalTableFromZip(table, msg.tableName);
          }
        }
      },
      null,
      this._disposables
    );
  }

  private _postMessage(msg: RelationListMessage): void {
    this._panel.webview.postMessage(msg);
  }

  private _getHtml(initialData: RelationListMessage): string {
    // scriptUri is the webview-safe URI for dist/relationList.js
    const scriptUri = this._panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'relationList.js')
    );
    const nonce = getNonce();
    // Embed initial data directly as a global so the script can read it
    // synchronously on load — avoids any postMessage race condition.
    const initJson = JSON.stringify(initialData);
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';" />
  <title>AL Table Relations List</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { display: flex; flex-direction: column; height: 100vh; overflow: hidden;
           font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
           background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
    #header   { padding: 8px 12px; background: var(--vscode-sideBar-background);
                border-bottom: 1px solid var(--vscode-panel-border); flex-shrink: 0; }
    #title    { font-size: 13px; font-weight: bold; }
    #subtitle { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
    #toolbar  { display: flex; align-items: center; gap: 8px; padding: 5px 10px;
                background: var(--vscode-sideBar-background);
                border-bottom: 1px solid var(--vscode-panel-border); flex-shrink: 0; flex-wrap: wrap; }
    #filterInput { flex: 1; min-width: 100px; background: var(--vscode-input-background);
                   color: var(--vscode-input-foreground);
                   border: 1px solid var(--vscode-input-border, #555);
                   padding: 3px 6px; border-radius: 3px; font-size: 12px; }
    #counter  { font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
    #dirBadge { font-size: 11px; font-weight: bold; padding: 2px 7px; border-radius: 3px;
                background: var(--vscode-badge-background, #4d4d4d);
                color: var(--vscode-badge-foreground, #fff); white-space: nowrap; }
    .toggle-group { display: flex; border: 1px solid var(--vscode-input-border, #555);
                    border-radius: 3px; overflow: hidden; flex-shrink: 0; }
    .toggle-btn { padding: 3px 10px; font-size: 11px; cursor: pointer; border: none;
                  background: var(--vscode-button-secondaryBackground, #3a3a3a);
                  color: var(--vscode-button-secondaryForeground, #ccc); white-space: nowrap; }
    .toggle-btn:hover  { background: var(--vscode-button-secondaryHoverBackground, #4a4a4a); }
    .toggle-btn.active { background: var(--vscode-button-background);
                         color: var(--vscode-button-foreground); font-weight: bold; }
    .icon-btn { padding: 3px 8px; font-size: 11px; cursor: pointer; border: none; border-radius: 3px;
                background: var(--vscode-button-secondaryBackground, #3a3a3a);
                color: var(--vscode-button-secondaryForeground, #ccc); white-space: nowrap; flex-shrink: 0; }
    .icon-btn:hover { background: var(--vscode-button-secondaryHoverBackground, #4a4a4a); }
    #tableContainer { flex: 1; overflow: auto; }
    table     { width: 100%; border-collapse: collapse; font-size: 12px; }
    thead th  { position: sticky; top: 0; z-index: 1;
                background: var(--vscode-sideBarSectionHeader-background, #252526);
                color: var(--vscode-sideBarSectionHeader-foreground, #bbb);
                padding: 5px 8px; text-align: left; cursor: pointer;
                border-bottom: 2px solid var(--vscode-panel-border);
                user-select: none; white-space: nowrap; }
    thead th:hover { background: var(--vscode-list-hoverBackground); }
    thead th.sort-asc::after  { content: ' \u25b2'; font-size: 9px; }
    thead th.sort-desc::after { content: ' \u25bc'; font-size: 9px; }
    tbody tr:hover { background: var(--vscode-list-hoverBackground); }
    td { padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border, #333);
         vertical-align: middle; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .name-link { color: var(--vscode-textLink-foreground, #4a9eff); cursor: pointer; }
    .name-link:hover { text-decoration: underline; }
    .badge-ext { display: inline-block; font-size: 9px; padding: 1px 4px; border-radius: 3px;
                 background: #1e3a5f; color: #8b9dc3; border: 1px solid #3a6ea8; }
    .badge-hop-direct { display: inline-block; font-size: 10px; padding: 1px 5px; border-radius: 3px;
                        background: #1a4030; color: #4ec9a0; border: 1px solid #3a8a6a; font-weight: bold; }
    .badge-hop-n { display: inline-block; font-size: 10px; padding: 1px 5px; border-radius: 3px;
                   background: #2a2a1a; color: #c9b04a; border: 1px solid #6a5a1a; }
    .rel-count { font-size: 11px; color: var(--vscode-descriptionForeground); }
    #emptyMsg  { padding: 20px; text-align: center;
                 color: var(--vscode-descriptionForeground); font-style: italic; }
    #pagination { display: flex; align-items: center; justify-content: center; gap: 8px;
                  padding: 6px; border-top: 1px solid var(--vscode-panel-border); flex-shrink: 0; }
    .pg-btn  { padding: 2px 10px; font-size: 11px; cursor: pointer; border: none; border-radius: 3px;
               background: var(--vscode-button-secondaryBackground, #3a3a3a);
               color: var(--vscode-button-secondaryForeground, #ccc); }
    .pg-btn:disabled { opacity: 0.4; cursor: default; }
    .pg-info { font-size: 11px; color: var(--vscode-descriptionForeground); }
  </style>
</head>
<body>
  <div id="header">
    <div id="rl-title">Loading\u2026</div>
    <div id="rl-subtitle"></div>
  </div>
  <div id="toolbar">
    <input id="filterInput" type="search" placeholder="Filter table name\u2026" />
    <span id="dirBadge" style="display:none"></span>
    <div class="toggle-group">
      <button class="toggle-btn" id="btnByRelation">By Relation</button>
      <button class="toggle-btn active" id="btnByTable">By Table</button>
    </div>
    <button class="icon-btn" id="btnExportCsv" title="Export current view as CSV">\u21e9 CSV</button>
    <span id="counter"></span>
  </div>
  <div id="tableContainer">
    <div id="emptyMsg">Waiting for data\u2026</div>
    <table id="relTable" style="display:none">
      <thead id="theadRow"><tr></tr></thead>
      <tbody id="tableBody"></tbody>
    </table>
  </div>
  <div id="pagination"></div>
  <script nonce="${nonce}">window.__RL_INIT__=${initJson};</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private _dispose(): void {
    RelationListPanel._instance = undefined;
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
