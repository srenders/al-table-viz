import * as vscode from 'vscode';
import { TableGraph } from '../model/tableGraph';
import { RelatedEntry } from '../model/types';
import { openExternalTableFromZip } from './openExternal';

type RelationListMessage =
  | { type: 'setRelationList'; tableName: string; depth: number; entries: RelatedEntry[]; tableFiles: Record<string, { filePath: string; line: number }> };

type RelationListIncoming =
  | { type: 'focusTable'; tableName: string }
  | { type: 'openFile'; filePath: string; line: number; tableName: string };

export class RelationListPanel {
  /** Called when the user clicks a table name in the list — lets DiagramPanel focus the diagram. */
  static onFocusTableRequest: ((tableName: string) => void) | undefined;
  private static _instance: RelationListPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private _graph: TableGraph | null = null;
  private _disposables: vscode.Disposable[] = [];

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  static show(extensionUri: vscode.Uri, graph: TableGraph, tableName: string, depth: number): RelationListPanel {
    if (RelationListPanel._instance) {
      RelationListPanel._instance._panel.reveal(vscode.ViewColumn.Beside);
    } else {
      const panel = vscode.window.createWebviewPanel(
        'alTableVizRelList',
        'AL Table Relations List',
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      RelationListPanel._instance = new RelationListPanel(panel);
    }
    RelationListPanel._instance.update(graph, tableName, depth);
    return RelationListPanel._instance;
  }

  static get instance(): RelationListPanel | undefined {
    return RelationListPanel._instance;
  }

  update(graph: TableGraph, tableName: string, depth: number): void {
    this._graph = graph;
    this._panel.title = `Relations: ${tableName}`;
    const entries = graph.getRelatedEntries(tableName, depth, 'both');
    const tableFiles: Record<string, { filePath: string; line: number }> = {};
    for (const t of graph.getTables()) {
      if (t.filePath) {
        tableFiles[t.name] = { filePath: t.filePath, line: t.declarationLine };
      }
    }
    this._postMessage({ type: 'setRelationList', tableName, depth, entries, tableFiles });
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private constructor(panel: vscode.WebviewPanel) {
    this._panel = panel;
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
    this._panel.webview.html = this._getHtml();
  }

  private _postMessage(msg: RelationListMessage): void {
    this._panel.webview.postMessage(msg);
  }

  private _getHtml(): string {
    const nonce = getNonce();
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
    .toggle-group { display: flex; border: 1px solid var(--vscode-input-border, #555); border-radius: 3px; overflow: hidden; flex-shrink: 0; }
    .toggle-btn { padding: 3px 10px; font-size: 11px; cursor: pointer; border: none;
                  background: var(--vscode-button-secondaryBackground, #3a3a3a);
                  color: var(--vscode-button-secondaryForeground, #ccc); white-space: nowrap; }
    .toggle-btn:hover  { background: var(--vscode-button-secondaryHoverBackground, #4a4a4a); }
    .toggle-btn.active { background: var(--vscode-button-background);
                         color: var(--vscode-button-foreground); font-weight: bold; }
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
  </style>
</head>
<body>
  <div id="header">
    <div id="title">Loading\u2026</div>
    <div id="subtitle"></div>
  </div>
  <div id="toolbar">
    <input id="filterInput" type="search" placeholder="Filter table name\u2026" />
    <div class="toggle-group">
      <button class="toggle-btn" id="btnByRelation">By Relation</button>
      <button class="toggle-btn active" id="btnByTable">By Table</button>
    </div>
    <span id="counter"></span>
  </div>
  <div id="tableContainer">
    <div id="emptyMsg">Waiting for data\u2026</div>
    <table id="relTable" style="display:none">
      <thead id="theadRow"><tr></tr></thead>
      <tbody id="tableBody"></tbody>
    </table>
  </div>

  <script nonce="${nonce}">
    const vscodeApi     = acquireVsCodeApi();
    const titleEl       = document.getElementById('title');
    const subtitleEl    = document.getElementById('subtitle');
    const filterInput   = document.getElementById('filterInput');
    const counterEl     = document.getElementById('counter');
    const relTable      = document.getElementById('relTable');
    const theadRow      = document.querySelector('#theadRow tr');
    const tableBody     = document.getElementById('tableBody');
    const emptyMsg      = document.getElementById('emptyMsg');
    const btnByRelation = document.getElementById('btnByRelation');
    const btnByTable    = document.getElementById('btnByTable');

    let allEntries = [];
    let tableFiles = {};
    let rootTable  = '';
    let viewMode   = 'byTable';   // 'byRelation' | 'byTable'
    let sortCol    = 'minHop';
    let sortAsc    = true;
    let filterText = '';

    const HEADERS_BY_RELATION = [
      { col: 'sourceTable', label: 'Source Table' },
      { col: 'sourceField', label: 'Source Field' },
      { col: 'targetTable', label: 'Target Table' },
      { col: 'targetField', label: 'Target Field' },
      { col: 'hopDistance', label: 'Hop' },
      { col: 'isExternal',  label: 'Ext' }
    ];
    const HEADERS_BY_TABLE = [
      { col: 'tableName',  label: 'Related Table' },
      { col: 'minHop',     label: 'Min Hop' },
      { col: 'relCount',   label: 'Relations' },
      { col: 'isExternal', label: 'Ext' }
    ];

    function buildHeaders(defs) {
      theadRow.innerHTML = '';
      defs.forEach(def => {
        const th = document.createElement('th');
        th.setAttribute('data-col', def.col);
        th.textContent = def.label;
        if (def.col === sortCol) { th.classList.add(sortAsc ? 'sort-asc' : 'sort-desc'); }
        th.addEventListener('click', () => {
          if (sortCol === def.col) { sortAsc = !sortAsc; } else { sortCol = def.col; sortAsc = true; }
          buildHeaders(defs);
          render();
        });
        theadRow.appendChild(th);
      });
    }

    // Build one row per unique related table (excluding root)
    function buildTableRows() {
      const map = new Map();
      const rootLower = rootTable.toLowerCase();
      for (const e of allEntries) {
        addTableEntry(map, e.sourceTable, e, rootLower);
        addTableEntry(map, e.targetTable, e, rootLower);
      }
      return Array.from(map.values());
    }

    function addTableEntry(map, name, entry, rootLower) {
      if (name.toLowerCase() === rootLower) { return; }
      if (!map.has(name)) {
        map.set(name, { tableName: name, minHop: entry.hopDistance,
                        relCount: 0, directCount: 0, isExternal: entry.isExternal });
      }
      const row = map.get(name);
      if (entry.hopDistance < row.minHop) { row.minHop = entry.hopDistance; }
      row.relCount++;
      if (entry.hopDistance === 1) { row.directCount++; }
      if (entry.isExternal) { row.isExternal = true; }
    }

    function render() {
      if (viewMode === 'byRelation') { renderByRelation(); } else { renderByTable(); }
    }

    function applySort(rows, col, asc) {
      rows.sort((a, b) => {
        let va = a[col], vb = b[col];
        if (typeof va === 'boolean') { va = va ? 1 : 0; vb = vb ? 1 : 0; }
        if (typeof va === 'number')  { return asc ? va - vb : vb - va; }
        return asc ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
      });
    }

    function showEmpty(msg) {
      relTable.style.display = 'none'; emptyMsg.style.display = ''; emptyMsg.textContent = msg;
    }

    function hopBadge(hop) {
      const span = document.createElement('span');
      span.className = hop === 1 ? 'badge-hop-direct' : 'badge-hop-n';
      span.textContent = hop === 1 ? 'direct' : hop + '\u00d7';
      return span;
    }

    function extBadge() {
      const span = document.createElement('span'); span.className = 'badge-ext'; span.textContent = 'ext'; return span;
    }

    function linkCell(name, fileInfo) {
      const td = document.createElement('td');
      const span = document.createElement('span');
      span.className = 'name-link';
      span.textContent = name;
      span.title = fileInfo ? 'Focus diagram \u2022 open source file' : 'Focus diagram on ' + name;
      span.addEventListener('click', () => {
        vscodeApi.postMessage({ type: 'focusTable', tableName: name });
        vscodeApi.postMessage({ type: 'openFile', filePath: fileInfo ? fileInfo.filePath : '', line: fileInfo ? fileInfo.line : 0, tableName: name });
      });
      td.appendChild(span);
      return td;
    }

    function renderByRelation() {
      const q = filterText.toLowerCase();
      let rows = q
        ? allEntries.filter(e =>
            e.sourceTable.toLowerCase().includes(q) || e.sourceField.toLowerCase().includes(q) ||
            e.targetTable.toLowerCase().includes(q) || e.targetField.toLowerCase().includes(q))
        : allEntries.slice();
      applySort(rows, sortCol, sortAsc);
      counterEl.textContent = rows.length + ' / ' + allEntries.length + ' relation' + (allEntries.length !== 1 ? 's' : '');
      if (rows.length === 0) { showEmpty(allEntries.length === 0 ? 'No relations found.' : 'No matches.'); return; }
      relTable.style.display = ''; emptyMsg.style.display = 'none'; tableBody.innerHTML = '';
      for (const e of rows) {
        const tr = document.createElement('tr');
        tr.appendChild(linkCell(e.sourceTable, tableFiles[e.sourceTable]));
        const tdSF = document.createElement('td'); tdSF.textContent = e.sourceField; tr.appendChild(tdSF);
        tr.appendChild(linkCell(e.targetTable, tableFiles[e.targetTable]));
        const tdTF = document.createElement('td'); tdTF.textContent = e.targetField || '\u2014'; tr.appendChild(tdTF);
        const tdH = document.createElement('td'); tdH.appendChild(hopBadge(e.hopDistance)); tr.appendChild(tdH);
        const tdE = document.createElement('td'); if (e.isExternal) { tdE.appendChild(extBadge()); } tr.appendChild(tdE);
        tableBody.appendChild(tr);
      }
    }

    function renderByTable() {
      let rows = buildTableRows();
      const q = filterText.toLowerCase();
      if (q) { rows = rows.filter(r => r.tableName.toLowerCase().includes(q)); }
      applySort(rows, sortCol, sortAsc);
      const total = buildTableRows().length;
      counterEl.textContent = rows.length + ' / ' + total + ' table' + (total !== 1 ? 's' : '');
      if (rows.length === 0) { showEmpty(total === 0 ? 'No related tables found.' : 'No matches.'); return; }
      relTable.style.display = ''; emptyMsg.style.display = 'none'; tableBody.innerHTML = '';
      for (const r of rows) {
        const tr = document.createElement('tr');
        tr.appendChild(linkCell(r.tableName, tableFiles[r.tableName]));
        const tdH = document.createElement('td'); tdH.appendChild(hopBadge(r.minHop)); tr.appendChild(tdH);
        const tdC = document.createElement('td');
        const cs = document.createElement('span'); cs.className = 'rel-count';
        cs.textContent = r.relCount + (r.directCount > 0 && r.relCount !== r.directCount ? ' (' + r.directCount + ' direct)' : '');
        tdC.appendChild(cs); tr.appendChild(tdC);
        const tdE = document.createElement('td'); if (r.isExternal) { tdE.appendChild(extBadge()); } tr.appendChild(tdE);
        tableBody.appendChild(tr);
      }
    }

    function setMode(mode) {
      viewMode = mode;
      btnByRelation.classList.toggle('active', mode === 'byRelation');
      btnByTable.classList.toggle('active',    mode === 'byTable');
      filterInput.placeholder = mode === 'byTable' ? 'Filter table name\u2026' : 'Filter table or field name\u2026';
      filterText = ''; filterInput.value = '';
      if (mode === 'byRelation') { sortCol = 'hopDistance'; sortAsc = true; buildHeaders(HEADERS_BY_RELATION); }
      else                       { sortCol = 'minHop';      sortAsc = true; buildHeaders(HEADERS_BY_TABLE); }
      render();
    }

    btnByRelation.addEventListener('click', () => setMode('byRelation'));
    btnByTable.addEventListener('click',    () => setMode('byTable'));
    filterInput.addEventListener('input', () => { filterText = filterInput.value; render(); });

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type !== 'setRelationList') { return; }
      allEntries = msg.entries;
      tableFiles = msg.tableFiles;
      rootTable  = msg.tableName;
      const directCount  = msg.entries.filter(e => e.hopDistance === 1).length;
      const transitCount = msg.entries.length - directCount;
      const tableCount   = buildTableRows().length;
      titleEl.textContent  = 'Related Tables: ' + msg.tableName;
      subtitleEl.textContent = 'Depth: ' + msg.depth + '\u00a0\u00b7\u00a0' +
        tableCount + ' table' + (tableCount !== 1 ? 's' : '') + '\u00a0\u00b7\u00a0' +
        directCount + ' direct, ' + transitCount + ' transitive relation' + (transitCount !== 1 ? 's' : '');
      setMode('byTable');
    });

    // Initial header build
    buildHeaders(HEADERS_BY_TABLE);
  </script>
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
