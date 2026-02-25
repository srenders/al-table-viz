import * as vscode from 'vscode';
import { WorkspaceScanner } from './scanner/workspaceScanner';
import { DiagramPanel } from './panel/diagramPanel';
import { RelationListPanel } from './panel/relationListPanel';
import { TableGraph } from './model/tableGraph';

let scanner: WorkspaceScanner | undefined;

export function activate(context: vscode.ExtensionContext): void {
  scanner = new WorkspaceScanner();

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
      // Determine which table to focus on
      const focusTable = resolveCurrentTable(graph, uri);
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
      RelationListPanel.show(context.extensionUri, graph, picked, depth);
    })
  );

  // Refresh diagram when graph updates after file/package changes (B1)
  scanner.onDidUpdate((graph: TableGraph) => {
    DiagramPanel.instance?.refresh(graph);
  });

  context.subscriptions.push(scanner);
}

export function deactivate(): void {
  scanner?.dispose();
}

/**
 * Ensures the graph has been built, triggering a workspace scan with a progress
 * notification if needed.
 * Returns `null` and surfaces a VS Code error message if scanning fails.
 */
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
 */
function resolveCurrentTable(graph: TableGraph, uri?: vscode.Uri): string | null {
  const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!targetUri) {
    return null;
  }
  const fsPath = targetUri.fsPath;
  // Find a table whose source file matches
  const table = graph.getTables().find(t => t.filePath === fsPath);
  return table?.name ?? null;
}
