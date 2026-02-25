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

// ---------------------------------------------------------------------------
// getRelatedEntries
// ---------------------------------------------------------------------------
describe('TableGraph.getRelatedEntries', () => {
  // buildGraph:
  //   SalesHeader --CustomerNo--> Customer
  //   SalesLine   --DocumentNo--> SalesHeader
  //   SalesLine   --No----------> Item (external)

  it('returns direct relations with hopDistance=1', () => {
    const g = buildGraph();
    const entries = g.getRelatedEntries('SalesHeader', 1, 'both');
    assert.ok(entries.length > 0, 'should have at least one entry');
    assert.ok(entries.every(e => e.hopDistance === 1), 'all entries at depth 1 should have hopDistance=1');
    const tables = new Set([...entries.map(e => e.sourceTable), ...entries.map(e => e.targetTable)]);
    assert.ok(tables.has('Customer'),  'Customer is reachable (out, hop 1)');
    assert.ok(tables.has('SalesLine'), 'SalesLine is reachable (in, hop 1)');
  });

  it('returns transitive relations at hopDistance=2', () => {
    const g = buildGraph();
    const entries = g.getRelatedEntries('SalesHeader', 2, 'both');
    const hop2 = entries.filter(e => e.hopDistance === 2);
    const tablesAtHop2 = new Set([...hop2.map(e => e.sourceTable), ...hop2.map(e => e.targetTable)]);
    assert.ok(tablesAtHop2.has('Item'), 'Item is 2 hops from SalesHeader (via SalesLine)');
  });

  it('excludes relations where both ends are the root (hopDistance=0)', () => {
    const g = new TableGraph(
      [makeTable('A'), makeTable('B')],
      [makeRel('A', 'Self', 'A'), makeRel('A', 'Ref', 'B')]
    );
    const entries = g.getRelatedEntries('A', 1, 'both');
    assert.ok(entries.every(e => e.hopDistance > 0), 'self-relation (hopDistance=0) must be excluded');
    const tables = new Set([...entries.map(e => e.sourceTable), ...entries.map(e => e.targetTable)]);
    assert.ok(tables.has('B'), 'relation to B should be included');
  });

  it('respects direction=out', () => {
    const g = buildGraph();
    const entries = g.getRelatedEntries('SalesHeader', 1, 'out');
    const tables = new Set([...entries.map(e => e.sourceTable), ...entries.map(e => e.targetTable)]);
    assert.ok(tables.has('Customer'),   'Customer is reachable via out edge');
    assert.ok(!tables.has('SalesLine'), 'SalesLine points TO SalesHeader, not reachable with out');
  });

  it('respects direction=in', () => {
    const g = buildGraph();
    const entries = g.getRelatedEntries('SalesHeader', 1, 'in');
    const tables = new Set([...entries.map(e => e.sourceTable), ...entries.map(e => e.targetTable)]);
    assert.ok(tables.has('SalesLine'),   'SalesLine points to SalesHeader, reachable via in');
    assert.ok(!tables.has('Customer'),   'Customer is an out neighbor, not reachable with in');
  });

  it('marks external table relations as isExternal=true', () => {
    const g = buildGraph(); // Item is external
    const entries = g.getRelatedEntries('SalesLine', 1, 'out');
    const itemRel = entries.find(e => e.targetTable === 'Item' || e.sourceTable === 'Item');
    assert.ok(itemRel, 'should have a relation involving Item');
    assert.equal(itemRel!.isExternal, true);
  });

  it('returns empty array for unknown root table', () => {
    const g = buildGraph();
    const entries = g.getRelatedEntries('DoesNotExist', 2, 'both');
    assert.equal(entries.length, 0);
  });

  it('is sorted by hopDistance, then sourceTable, then sourceField', () => {
    const g = buildGraph();
    const entries = g.getRelatedEntries('SalesHeader', 2, 'both');
    for (let i = 1; i < entries.length; i++) {
      const prev = entries[i - 1];
      const curr = entries[i];
      assert.ok(prev.hopDistance <= curr.hopDistance, 'must be sorted by hopDistance');
      if (prev.hopDistance === curr.hopDistance) {
        assert.ok(
          prev.sourceTable.localeCompare(curr.sourceTable) <= 0,
          `sourceTable order wrong: ${prev.sourceTable} vs ${curr.sourceTable}`
        );
        if (prev.sourceTable === curr.sourceTable) {
          assert.ok(
            prev.sourceField.localeCompare(curr.sourceField) <= 0,
            `sourceField order wrong: ${prev.sourceField} vs ${curr.sourceField}`
          );
        }
      }
    }
  });
});
