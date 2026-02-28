import * as vscode from 'vscode';
import * as path from 'path';
import { WorkspaceScanner } from './scanner/workspaceScanner';
import { DiagramPanel } from './panel/diagramPanel';
import { RelationListPanel } from './panel/relationListPanel';
import { TableGraph } from './model/tableGraph';

let scanner: WorkspaceScanner | undefined;

export function activate(context: vscode.ExtensionContext): void {
  scanner = new WorkspaceScanner(context);
  // Share the single output channel with DiagramPanel
  DiagramPanel.setOutputChannel(scanner.outputChannel);

  // Show All Table Relations
  context.subscriptions.push(
    vscode.commands.registerCommand('alTableViz.showAll', async () => {
      const graph = await ensureGraph(scanner!);
      if (!graph) { return; }
      DiagramPanel.create(context.extensionUri, graph);
    })
  );

  // Show Relations for Current Table
  context.subscriptions.push(
    vscode.commands.registerCommand('alTableViz.showCurrentTable', async (uri?: vscode.Uri) => {
      const graph = await ensureGraph(scanner!);
      if (!graph) { return; }
      const focusTable = resolveCurrentTable(graph, uri, scanner!.outputChannel);
      DiagramPanel.create(context.extensionUri, graph, focusTable ?? undefined);
    })
  );

  // Find Related Tables — QuickPick → open diagram focused on table + open relation list panel
  context.subscriptions.push(
    vscode.commands.registerCommand('alTableViz.findRelated', async () => {
      const graph = await ensureGraph(scanner!);
      if (!graph) { return; }
      const tableNames = graph.getTables()
        .map(t => t.name)
        .sort((a, b) => a.localeCompare(b));
      const picked = await vscode.window.showQuickPick(tableNames, {
        placeHolder: 'Select a table to find all related tables…',
        title: 'AL Table Viz: Find Related Tables'
      });
      if (!picked) { return; }
      const config = vscode.workspace.getConfiguration('alTableViz');
      const depth: number = config.get('defaultDepth', 2);
      DiagramPanel.create(context.extensionUri, graph, picked);
      RelationListPanel.show(context.extensionUri, graph, picked, depth, 'out');
    })
  );

  // Rescan — clears all caches and forces a cold rebuild of the workspace graph
  context.subscriptions.push(
    vscode.commands.registerCommand('alTableViz.rescan', async () => {
      DiagramPanel.instance?.postLoading(true);
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'AL Table Viz: Re-scanning workspace…' },
          async () => { await scanner!.forceRescan(); }
        );
      } catch (err) {
        DiagramPanel.instance?.postError(String(err));
        vscode.window.showErrorMessage(`AL Table Viz: rescan failed — ${err}`);
      }
    })
  );

  // Refresh diagram when graph updates after file/package changes
  scanner.onDidUpdate((graph: TableGraph) => {
    DiagramPanel.instance?.refresh(graph);
  });

  context.subscriptions.push(scanner);
}

export function deactivate(): void {
  scanner?.dispose();
}

async function ensureGraph(scanner: WorkspaceScanner): Promise<TableGraph | null> {
  let graph = scanner.getGraph();
  if (graph) { return graph; }
  DiagramPanel.instance?.postLoading(true);
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'AL Table Viz: Scanning workspace…' },
      async () => { graph = await scanner.scan(); }
    );
  } catch (err) {
    DiagramPanel.instance?.postError(String(err));
    vscode.window.showErrorMessage(`AL Table Viz: scan failed — ${err}`);
    return null;
  }
  return graph!;
}

/**
 * Tries to determine the AL table name associated with the currently active
 * editor (or the URI passed from the context menu).
 * Falls back to case-insensitive basename comparison when an exact path match
 * fails (handles symlinked paths and differently-cased drives on Windows).
 */
function resolveCurrentTable(graph: TableGraph, uri: vscode.Uri | undefined, out: vscode.OutputChannel): string | null {
  const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!targetUri) { return null; }
  const fsPath = targetUri.fsPath;

  // Exact match first
  const exact = graph.getTables().find(t => t.filePath === fsPath);
  if (exact) { return exact.name; }

  // Case-insensitive basename fallback (handles Windows drive-case variations and symlinks)
  const base = path.basename(fsPath).toLowerCase();
  const fallback = graph.getTables().find(t => t.filePath && path.basename(t.filePath).toLowerCase() === base);
  if (fallback) {
    out.appendLine(`[resolveCurrentTable] Exact path not found for "${fsPath}"; matched by basename to "${fallback.filePath}"`);
    return fallback.name;
  }

  return null;
}

