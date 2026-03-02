import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { parseALFile, ALTableExtension } from '../parser/alFileParser';
import { readAppPackage } from '../parser/appPackageReader';
import { AppPackageCache } from '../parser/appPackageCache';
import { TableGraph } from '../model/tableGraph';
import { ALTable, ALRelation } from '../model/types';

interface ALFileCache {
  tables:     ALTable[];
  extensions: ALTableExtension[];
  relations:  ALRelation[];
}

export class WorkspaceScanner {
  private _graph: TableGraph | null = null;
  private _onDidUpdate = new vscode.EventEmitter<TableGraph>();
  readonly onDidUpdate = this._onDidUpdate.event;

  private _disposables: vscode.Disposable[] = [];
  /** Output channel created on first scan; owned and disposed by this instance. */
  private _out: vscode.OutputChannel | undefined;
  /** Per-file cache for AL source files — only changed files are re-parsed */
  private _alFileCache = new Map<string, ALFileCache>();
  /** Disk-persistent cache for parsed .app symbol packages */
  private _appCache: AppPackageCache | undefined;

  private _getOutput(): vscode.OutputChannel {
    if (!this._out) {
      this._out = vscode.window.createOutputChannel('AL Table Visualizer');
    }
    return this._out;
  }

  /** Exposes the output channel so other components can share it (e.g. DiagramPanel). */
  get outputChannel(): vscode.OutputChannel {
    return this._getOutput();
  }

  constructor(context?: vscode.ExtensionContext) {
    if (context) {
      const cacheDir = vscode.Uri.joinPath(context.globalStorageUri, 'appcache').fsPath;
      this._appCache = new AppPackageCache(cacheDir);
    }

    const alWatcher = vscode.workspace.createFileSystemWatcher('**/*.al');
    alWatcher.onDidChange(uri => this._scheduleAlRescan(uri.fsPath));
    alWatcher.onDidCreate(uri => this._scheduleAlRescan(uri.fsPath));
    alWatcher.onDidDelete(uri => { this._alFileCache.delete(uri.fsPath); this._scheduleRescan(); });
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
   * Debounced full rescan: waits 1 second of quiet after the last file-system event.
   */
  private _scheduleRescan(): void {
    if (this._rescanTimer) { clearTimeout(this._rescanTimer); }
    this._rescanTimer = setTimeout(() => { this.scan().catch(console.error); }, 1000);
  }

  /**
   * Debounced incremental rescan: re-parses only the changed AL file, then
   * rebuilds the graph from the per-file cache without touching .app packages.
   */
  private _scheduleAlRescan(fsPath: string): void {
    if (this._rescanTimer) { clearTimeout(this._rescanTimer); }
    this._rescanTimer = setTimeout(() => { this._rescanAlFile(fsPath).catch(console.error); }, 1000);
  }

  /**
   * Re-parses a single .al file and rebuilds the graph from the cached data.
   */
  private async _rescanAlFile(fsPath: string): Promise<void> {
    // Fall back to full rescan if there's no existing graph (first run)
    if (!this._graph) { void this.scan(); return; }
    const out = this._getOutput();
    out.appendLine(`[incremental] Re-parsing ${fsPath}`);
    try {
      const content = await fs.readFile(fsPath, 'utf8');
      const parsed = parseALFile(content, fsPath);
      this._alFileCache.set(fsPath, {
        tables: parsed.tables,
        extensions: parsed.extensions,
        relations: parsed.relations
      });
    } catch (err) {
      out.appendLine(`  ERROR reading ${fsPath}: ${err}`);
      this._alFileCache.delete(fsPath);
    }
    this._rebuildGraphFromCache(out);
  }

  /**
   * Rebuild the TableGraph from the current per-file AL cache + existing external tables.
   * Does NOT re-read .app packages (they are unchanged).
   */
  private _rebuildGraphFromCache(out: vscode.OutputChannel): void {
    const tables:     ALTable[]          = [];
    const relations:  ALRelation[]       = [];
    const extensions: ALTableExtension[] = [];

    for (const entry of this._alFileCache.values()) {
      for (const t of entry.tables)     { tables.push(t); }
      for (const r of entry.relations)  { relations.push(r); }
      for (const e of entry.extensions) { extensions.push(e); }
    }

    // Re-add external tables from the existing graph (unchanged)
    if (this._graph) {
      for (const t of this._graph.getTables()) {
        if (t.isExternal && !tables.some(st => st.name.toLowerCase() === t.name.toLowerCase())) {
          tables.push(t);
        }
      }
      for (const r of this._graph.getRelations()) {
        // Include external-source relations (not already in AL cache)
        const srcIsExternal = tables.some(t => t.name.toLowerCase() === r.sourceTable.toLowerCase() && t.isExternal);
        if (srcIsExternal) { relations.push(r); }
      }
    }

    const graph = new TableGraph(tables, relations);
    for (const ext of extensions) {
      graph.mergeExtension(ext.baseName, ext.extraFields, ext.extraRelations);
    }

    out.appendLine(`[incremental] Graph rebuilt: ${graph.getTables().length} tables`);
    this._graph = graph;
    this._onDidUpdate.fire(graph);
  }

  async scan(): Promise<TableGraph> {
    const out = this._getOutput();
    out.appendLine('');
    out.appendLine('=== AL Table Visualizer: scanning workspace ===');

    const config        = vscode.workspace.getConfiguration('alTableViz');
    const showExternal  = config.get<boolean>('showExternalTables', true);
    const excludedPkgs  = config.get<string[]>('excludedAppPackages', []).map(s => s.toLowerCase());

    const tables:     ALTable[]           = [];
    const relations:  ALRelation[]        = [];
    const extensions: ALTableExtension[]  = [];

    // ── Scan .al source files ─────────────────────────────────────────────────
    const alFiles = await vscode.workspace.findFiles('**/*.al', '**/node_modules/**');
    out.appendLine(`Found ${alFiles.length} .al files`);

    for (const uri of alFiles) {
      try {
        const content = await fs.readFile(uri.fsPath, 'utf8');
        const parsed  = parseALFile(content, uri.fsPath);

        // Stamp each source table with the workspace folder name
        const wsFolder = vscode.workspace.getWorkspaceFolder(uri);
        if (wsFolder) {
          for (const t of parsed.tables) { t.sourceFolder = wsFolder.name; }
        }

        if (parsed.tables.length > 0) {
          out.appendLine(`  ${uri.fsPath} → ${parsed.tables.length} table(s): ${parsed.tables.map(t => t.name).join(', ')}`);
        }
        if (parsed.extensions.length > 0) {
          out.appendLine(`  ${uri.fsPath} → ${parsed.extensions.length} extension(s): ${parsed.extensions.map(e => e.baseName).join(', ')}`);
        }

        this._alFileCache.set(uri.fsPath, {
          tables: parsed.tables,
          extensions: parsed.extensions,
          relations: parsed.relations
        });

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
      const relKeys = new Set<string>(
        relations.map(r => `${r.sourceTable.toLowerCase()}||${r.sourceField.toLowerCase()}||${r.targetTable.toLowerCase()}`)
      );
      // Track content hashes of .app files already processed this scan run.
      // Identical files in multiple .alpackages folders share one parse operation.
      const processedAppHashes = new Set<string>();
      for (const uri of appFiles) {
        const basename = path.basename(uri.fsPath).toLowerCase();
        // Skip packages matching the exclusion list
        if (excludedPkgs.some(ex => basename.includes(ex))) {
          out.appendLine(`  [skipped by excludedAppPackages] ${uri.fsPath}`);
          continue;
        }
        try {
          const shortName = uri.fsPath.split(/[\\/]/).slice(-2).join('/');
          let result: Awaited<ReturnType<typeof readAppPackage>>;

          // Read bytes and compute content hash for path-independent deduplication
          const bytes = await fs.readFile(uri.fsPath);
          const contentHash = crypto.createHash('sha256').update(bytes).digest('hex');

          // Skip if a file with identical content was already processed this run
          if (processedAppHashes.has(contentHash)) {
            out.appendLine(`  [${shortName}] Skipped duplicate (same content as another .alpackages copy)`);
            continue;
          }
          processedAppHashes.add(contentHash);

          // Try content-hash-keyed disk cache
          const cached = this._appCache
            ? await this._appCache.get(contentHash)
            : null;

          if (cached) {
            out.appendLine(`  [${shortName}] Using cached result (${cached.tables.length} tables)`);
            result = cached;
          } else {
            result = await readAppPackage(new Uint8Array(bytes), uri.fsPath);
            for (const line of result.log) {
              out.appendLine(`  [${shortName}] ${line}`);
            }
            // Write to cache asynchronously (non-blocking)
            if (this._appCache) {
              this._appCache.set(contentHash, result).catch(() => {});
            }
          }

          const newTables = result.tables.filter(
            t => !tables.some(st => st.name.toLowerCase() === t.name.toLowerCase())
          );
          if (newTables.length) {
            out.appendLine(`  [${shortName}] Added ${newTables.length} external table(s)`);
            tables.push(...newTables);
          }
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

  /** Clears all caches and runs a full cold scan. */
  async forceRescan(): Promise<TableGraph> {
    this._alFileCache.clear();
    if (this._appCache) { await this._appCache.clear(); }
    this._graph = null;
    return this.scan();
  }

  getGraph(): TableGraph | null { return this._graph; }

  dispose(): void {
    if (this._rescanTimer) { clearTimeout(this._rescanTimer); }
    this._disposables.forEach(d => d.dispose());
    this._onDidUpdate.dispose();
    this._out?.dispose();
  }
}
