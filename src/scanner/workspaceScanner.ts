import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import { parseALFile, ALTableExtension } from '../parser/alFileParser';
import { readAppPackage } from '../parser/appPackageReader';
import { TableGraph } from '../model/tableGraph';
import { ALTable, ALRelation } from '../model/types';

export class WorkspaceScanner {
  private _graph: TableGraph | null = null;
  private _onDidUpdate = new vscode.EventEmitter<TableGraph>();
  readonly onDidUpdate = this._onDidUpdate.event;

  private _disposables: vscode.Disposable[] = [];
  /** Output channel created on first scan; owned and disposed by this instance. */
  private _out: vscode.OutputChannel | undefined;

  private _getOutput(): vscode.OutputChannel {
    if (!this._out) {
      this._out = vscode.window.createOutputChannel('AL Table Visualizer');
    }
    return this._out;
  }

  constructor() {
    const alWatcher = vscode.workspace.createFileSystemWatcher('**/*.al');
    alWatcher.onDidChange(() => this._scheduleRescan());
    alWatcher.onDidCreate(() => this._scheduleRescan());
    alWatcher.onDidDelete(() => this._scheduleRescan());
    this._disposables.push(alWatcher);

    // Also watch .app symbol packages — changes trigger a full rescan
    const appWatcher = vscode.workspace.createFileSystemWatcher('**/*.app');
    appWatcher.onDidChange(() => this._scheduleRescan());
    appWatcher.onDidCreate(() => this._scheduleRescan());
    appWatcher.onDidDelete(() => this._scheduleRescan());
    this._disposables.push(appWatcher);
  }

  private _rescanTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Debounced rescan: waits 1 second of quiet after the last file-system event
   * before triggering a full scan. Avoids hammering the parser during rapid
   * saves or multi-file operations such as a git checkout.
   */
  private _scheduleRescan(): void {
    if (this._rescanTimer) { clearTimeout(this._rescanTimer); }
    this._rescanTimer = setTimeout(() => { this.scan().catch(console.error); }, 1000);
  }

  async scan(): Promise<TableGraph> {
    const out = this._getOutput();
    out.appendLine('');
    out.appendLine('=== AL Table Visualizer: scanning workspace ===');

    const config        = vscode.workspace.getConfiguration('alTableViz');
    const showExternal  = config.get<boolean>('showExternalTables', true);

    const tables:     ALTable[]           = [];
    const relations:  ALRelation[]        = [];
    const extensions: ALTableExtension[]  = [];

    // ── Scan .al source files (single pass) ──────────────────────────────────
    const alFiles = await vscode.workspace.findFiles('**/*.al', '**/node_modules/**');
    out.appendLine(`Found ${alFiles.length} .al files`);

    for (const uri of alFiles) {
      try {
        const content = await fs.readFile(uri.fsPath, 'utf8');
        const parsed  = parseALFile(content, uri.fsPath);

        if (parsed.tables.length > 0) {
          out.appendLine(`  ${uri.fsPath} → ${parsed.tables.length} table(s): ${parsed.tables.map(t => t.name).join(', ')}`);
        }
        if (parsed.extensions.length > 0) {
          out.appendLine(`  ${uri.fsPath} → ${parsed.extensions.length} extension(s): ${parsed.extensions.map(e => e.baseName).join(', ')}`);
        }

        for (const t of parsed.tables) { tables.push(t); }
        relations.push(...parsed.relations);
        for (const e of parsed.extensions) { extensions.push(e); }
      } catch (err) {
        out.appendLine(`  ERROR reading ${uri.fsPath}: ${err}`);
      }
    }

    out.appendLine(`Total source tables: ${tables.length},  relations: ${relations.length},  extensions: ${extensions.length}`);

    // ── Scan .app symbol packages ─────────────────────────────────────────────
    if (showExternal) {
      const appFiles = await vscode.workspace.findFiles('**/*.app', '**/node_modules/**');
      out.appendLine(`Found ${appFiles.length} .app file(s)`);
      // Pre-seed dedup set with source-level relation keys
      const relKeys = new Set<string>(
        relations.map(r => `${r.sourceTable.toLowerCase()}||${r.sourceField.toLowerCase()}||${r.targetTable.toLowerCase()}`)
      );
      for (const uri of appFiles) {
        try {
          const bytes  = await fs.readFile(uri.fsPath);
          const result = await readAppPackage(new Uint8Array(bytes), uri.fsPath);
          const shortName = uri.fsPath.split(/[\\/]/).slice(-2).join('/');
          for (const line of result.log) {
            out.appendLine(`  [${shortName}] ${line}`);
          }
          const newTables = result.tables.filter(
            t => !tables.some(st => st.name.toLowerCase() === t.name.toLowerCase())
          );
          if (newTables.length) {
            out.appendLine(`  [${shortName}] Added ${newTables.length} external table(s)`);
            tables.push(...newTables);
          }
          // Collect external relations (deduplicated)
          for (const rel of result.relations) {
            const key = `${rel.sourceTable.toLowerCase()}||${rel.sourceField.toLowerCase()}||${rel.targetTable.toLowerCase()}`;
            if (!relKeys.has(key)) {
              relKeys.add(key);
              relations.push(rel);
            }
          }
        } catch (err) {
          out.appendLine(`  ERROR reading ${uri.fsPath}: ${err}`);
        }
      }
    }

    // ── Build graph ───────────────────────────────────────────────────────────
    const graph = new TableGraph(tables, relations);

    // ── Merge table extensions ────────────────────────────────────────────────
    for (const ext of extensions) {
      graph.mergeExtension(ext.baseName, ext.extraFields, ext.extraRelations);
    }

    out.appendLine(`Graph built: ${graph.getTables().length} tables total`);

    this._graph = graph;
    this._onDidUpdate.fire(graph);
    return graph;
  }

  getGraph(): TableGraph | null { return this._graph; }

  dispose(): void {
    this._disposables.forEach(d => d.dispose());
    this._onDidUpdate.dispose();
    this._out?.dispose();
  }
}

