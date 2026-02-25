import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import JSZip from 'jszip';
import { ALTable } from '../model/types';

/**
 * Opens an external (app-package) table's AL source in a read-only virtual
 * document by extracting the matching *.Table.al entry from the .app ZIP.
 *
 * Strategy:
 * 1. Fast path — match ZIP entry filename to the normalised table name
 *    (e.g. "G/L Entry" → "GLEntry").
 * 2. Slow path — scan every *.Table.al entry and check whether the first
 *    300 characters contain "table <id>".
 */
export async function openExternalTableFromZip(
  table: ALTable | undefined,
  tableName: string
): Promise<void> {
  if (!table?.appFilePath) {
    vscode.window.showInformationMessage(
      `No package source available for "${tableName}".`
    );
    return;
  }

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(table.appFilePath);
  } catch (err) {
    vscode.window.showErrorMessage(`Cannot read package file: ${err}`);
    return;
  }

  let zip: InstanceType<typeof JSZip>;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (err) {
    vscode.window.showErrorMessage(`Cannot open package ZIP: ${err}`);
    return;
  }

  const entries = zip.file(/\.Table\.al$/i);
  if (entries.length === 0) {
    vscode.window.showInformationMessage(
      `No AL source files found inside the package for "${tableName}".`
    );
    return;
  }

  // Fast path: normalise table name and compare to entry filename stem
  const normName = tableName.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  let source = await tryEntry(
    entries.find(e => {
      const stem = e.name.split('/').pop()!.replace(/\.Table\.al$/i, '');
      return stem.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() === normName;
    })
  );

  // Slow path: scan entry content for "table <id>"
  if (!source && table.id > 0) {
    const idRe = new RegExp(`^\\s*table\\s+${table.id}\\b`, 'im');
    for (const entry of entries) {
      const text = await tryEntry(entry);
      if (text && idRe.test(text.substring(0, 300))) {
        source = text;
        break;
      }
    }
  }

  if (!source) {
    vscode.window.showInformationMessage(
      `Could not locate source for "${tableName}" (id=${table.id}) inside the package.`
    );
    return;
  }

  const doc = await vscode.workspace.openTextDocument({ content: source, language: 'al' });
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: true });
}

async function tryEntry(entry: JSZip.JSZipObject | undefined): Promise<string | undefined> {
  if (!entry) { return undefined; }
  try { return await entry.async('string'); } catch { return undefined; }
}
