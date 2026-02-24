/**
 * Unit tests for TableGraph — run with:
 *   npm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TableGraph } from '../model/tableGraph';
import { ALTable, ALRelation } from '../model/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeTable(name: string, isExternal = false, namespace?: string): ALTable {
  return { id: 1, name, filePath: '', declarationLine: 1, fields: [], isExternal, namespace };
}

function makeRel(sourceTable: string, sourceField: string, targetTable: string): ALRelation {
  return { sourceTable, sourceField, targetTable, targetField: '', isConditional: false };
}

// Table set: Customer --OrderNo--> SalesHeader --CustomerNo--> Customer
function buildGraph(): TableGraph {
  const tables = [
    makeTable('Customer'),
    makeTable('SalesHeader'),
    makeTable('SalesLine'),
    makeTable('Item', true, 'Microsoft.Inventory.Item'),
  ];
  const relations = [
    makeRel('SalesHeader', 'CustomerNo', 'Customer'),
    makeRel('SalesLine',   'DocumentNo', 'SalesHeader'),
    makeRel('SalesLine',   'No',         'Item'),
  ];
  return new TableGraph(tables, relations);
}

// ---------------------------------------------------------------------------
// getSubgraph
// ---------------------------------------------------------------------------
describe('TableGraph.getSubgraph', () => {
  it('depth=1 out from SalesHeader includes direct targets', () => {
    const g = buildGraph();
    const sub = g.getSubgraph('SalesHeader', 1, 'out');
    const names = sub.tables.map(t => t.name).sort();
    assert.ok(names.includes('SalesHeader'));
    assert.ok(names.includes('Customer'));
    assert.ok(!names.includes('SalesLine'), 'SalesLine points TO SalesHeader, not outgoing from it');
  });

  it('depth=1 in from SalesHeader includes SalesLine', () => {
    const g = buildGraph();
    const sub = g.getSubgraph('SalesHeader', 1, 'in');
    const names = sub.tables.map(t => t.name);
    assert.ok(names.includes('SalesLine'));
    assert.ok(!names.includes('Customer'));
  });

  it('depth=1 both from SalesHeader includes Customer and SalesLine', () => {
    const g = buildGraph();
    const sub = g.getSubgraph('SalesHeader', 1, 'both');
    const names = sub.tables.map(t => t.name);
    assert.ok(names.includes('Customer'));
    assert.ok(names.includes('SalesLine'));
  });

  it('depth=2 reaches Item via SalesLine', () => {
    const g = buildGraph();
    const sub = g.getSubgraph('SalesHeader', 2, 'in');
    const names = sub.tables.map(t => t.name);
    // SalesHeader ← SalesLine → Item
    assert.ok(names.includes('Item'));
  });

  it('returns only relations within the subgraph', () => {
    const g = buildGraph();
    const sub = g.getSubgraph('SalesHeader', 1, 'out');
    for (const rel of sub.relations) {
      const tableNames = sub.tables.map(t => t.name.toLowerCase());
      assert.ok(tableNames.includes(rel.sourceTable.toLowerCase()));
      assert.ok(tableNames.includes(rel.targetTable.toLowerCase()));
    }
  });

  it('handles unknown table gracefully', () => {
    const g = buildGraph();
    const sub = g.getSubgraph('DoesNotExist', 2, 'both');
    assert.equal(sub.tables.length, 0);
    assert.equal(sub.relations.length, 0);
  });
});

// ---------------------------------------------------------------------------
// getSourceSubgraph
// ---------------------------------------------------------------------------
describe('TableGraph.getSourceSubgraph', () => {
  it('includes all source tables and reachable external tables', () => {
    const g = buildGraph();
    const sub = g.getSourceSubgraph(1);
    const names = sub.tables.map(t => t.name);
    // All 3 source tables + Item (reachable from SalesLine)
    assert.ok(names.includes('Customer'));
    assert.ok(names.includes('SalesHeader'));
    assert.ok(names.includes('SalesLine'));
    assert.ok(names.includes('Item'));
  });
});

// ---------------------------------------------------------------------------
// getNamespaces
// ---------------------------------------------------------------------------
describe('TableGraph.getNamespaces', () => {
  it('returns distinct 2-segment namespace prefixes for external tables', () => {
    const tables = [
      makeTable('A', true, 'Microsoft.Finance.GL'),
      makeTable('B', true, 'Microsoft.Finance.Customer'),
      makeTable('C', true, 'Microsoft.Inventory.Item'),
      makeTable('D', false),  // source table, no namespace
    ];
    const g = new TableGraph(tables, []);
    const ns = g.getNamespaces();
    assert.deepEqual(ns, ['Microsoft.Finance', 'Microsoft.Inventory']);
  });

  it('returns empty array when no external tables have namespaces', () => {
    const g = new TableGraph([makeTable('X')], []);
    assert.deepEqual(g.getNamespaces(), []);
  });
});

// ---------------------------------------------------------------------------
// mergeExtension — isFromExtension flag
// ---------------------------------------------------------------------------
describe('TableGraph.mergeExtension', () => {
  it('sets isFromExtension on merged fields', () => {
    const g = new TableGraph([makeTable('Customer')], []);
    const extraField = { id: 50000, name: 'MyField', dataType: 'Text[50]' };
    g.mergeExtension('Customer', [extraField], []);
    const table = g.getTable('Customer')!;
    assert.equal(table.fields.length, 1);
    assert.equal(table.fields[0].isFromExtension, true);
  });

  it('does not mutate the original extraField object', () => {
    const g = new TableGraph([makeTable('Customer')], []);
    const extraField = { id: 50000, name: 'MyField', dataType: 'Text[50]' };
    g.mergeExtension('Customer', [extraField], []);
    // Original should not have isFromExtension set (we spread a copy)
    assert.equal((extraField as any).isFromExtension, undefined);
  });

  it('merges extension relations into the graph', () => {
    const g = new TableGraph([makeTable('Customer'), makeTable('Region')], []);
    const rel = makeRel('Customer', 'RegionCode', 'Region');
    g.mergeExtension('Customer', [], [rel]);
    assert.equal(g.getRelations().length, 1);
  });

  it('silently ignores unknown base table', () => {
    const g = new TableGraph([], []);
    assert.doesNotThrow(() => g.mergeExtension('NonExistent', [], []));
  });
});

// ---------------------------------------------------------------------------
// filterByName
// ---------------------------------------------------------------------------
describe('TableGraph.filterByName', () => {
  it('returns matching tables', () => {
    const g = buildGraph();
    const sub = g.filterByName('Sales');
    const names = sub.tables.map(t => t.name);
    assert.ok(names.includes('SalesHeader'));
    assert.ok(names.includes('SalesLine'));
    assert.ok(!names.includes('Customer'));
  });

  it('returns all tables for empty query', () => {
    const g = buildGraph();
    const sub = g.filterByName('');
    assert.equal(sub.tables.length, g.getTables().length);
  });
});

// ---------------------------------------------------------------------------
// Cycle detection
// ---------------------------------------------------------------------------
describe('TableGraph.getSubgraph – cycle safety', () => {
  it('terminates and includes both nodes when relations form a cycle (A→B→A)', () => {
    // Without the visitedNames guard, A→B→A would loop forever.
    const g = new TableGraph(
      [makeTable('A'), makeTable('B')],
      [makeRel('A', 'BRef', 'B'), makeRel('B', 'ARef', 'A')]
    );
    const sub = g.getSubgraph('A', 5, 'both');
    const names = sub.tables.map(t => t.name).sort();
    assert.deepEqual(names, ['A', 'B']);
  });

  it('terminates for a self-referencing table (A→A)', () => {
    const g = new TableGraph(
      [makeTable('A')],
      [makeRel('A', 'ParentRef', 'A')]
    );
    const sub = g.getSubgraph('A', 3, 'both');
    assert.equal(sub.tables.length, 1);
    assert.equal(sub.tables[0].name, 'A');
  });
});

// ---------------------------------------------------------------------------
// getSubgraphForNamespace
// ---------------------------------------------------------------------------
describe('TableGraph.getSubgraphForNamespace', () => {
  it('returns namespace tables and their reachable neighbours', () => {
    const tables = [
      makeTable('Customer', false),
      makeTable('Salesperson', true, 'Microsoft.Sales.Salesperson'),
      makeTable('Currency', true, 'Microsoft.Finance.Currency'),
    ];
    const rels = [makeRel('Customer', 'SalespersonCode', 'Salesperson')];
    const g = new TableGraph(tables, rels);
    const sub = g.getSubgraphForNamespace('Microsoft.Sales', 1);
    const names = sub.tables.map(t => t.name).sort();
    assert.ok(names.includes('Salesperson'), 'seed namespace table should be included');
    assert.ok(names.includes('Customer'), 'Customer is 1 hop from Salesperson');
    assert.ok(!names.includes('Currency'), 'Currency is in a different namespace and not reachable');
  });

  it('returns empty subgraph for a namespace prefix with no matching tables', () => {
    const g = buildGraph();
    const sub = g.getSubgraphForNamespace('Microsoft.Unknown', 1);
    assert.equal(sub.tables.length, 0);
    assert.equal(sub.relations.length, 0);
  });

  it('only includes relations between retained tables', () => {
    const tables = [
      makeTable('Customer', false),
      makeTable('Salesperson', true, 'Microsoft.Sales.Salesperson'),
      makeTable('Unrelated', false),
    ];
    const rels = [
      makeRel('Customer', 'SalespersonCode', 'Salesperson'),
      makeRel('Unrelated', 'X', 'Customer'), // Unrelated should not appear
    ];
    const g = new TableGraph(tables, rels);
    // depth=1 from Salesperson: reaches Customer, but not Unrelated
    const sub = g.getSubgraphForNamespace('Microsoft.Sales', 1);
    for (const rel of sub.relations) {
      const inSub = sub.tables.map(t => t.name.toLowerCase());
      assert.ok(inSub.includes(rel.sourceTable.toLowerCase()), `source ${rel.sourceTable} should be in subgraph`);
      assert.ok(inSub.includes(rel.targetTable.toLowerCase()), `target ${rel.targetTable} should be in subgraph`);
    }
  });
});
