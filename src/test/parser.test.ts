/**
 * Unit tests for alFileParser — run with:
 *   npm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseALFile } from '../parser/alFileParser';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const FP = '/fake/Tables.al';

function parse(content: string) {
  return parseALFile(content, FP);
}

// ---------------------------------------------------------------------------
// Table detection
// ---------------------------------------------------------------------------
describe('parseALFile – tables', () => {
  it('parses a simple unquoted table', () => {
    const r = parse('table 18 Customer\n{\n  fields {}\n}');
    assert.equal(r.tables.length, 1);
    assert.equal(r.tables[0].name, 'Customer');
    assert.equal(r.tables[0].id, 18);
    assert.equal(r.tables[0].filePath, FP);
    assert.equal(r.tables[0].isExternal, false);
  });

  it('parses a quoted table name', () => {
    const r = parse('table 18 "Customer" {}');
    assert.equal(r.tables[0].name, 'Customer');
  });

  it('captures declarationLine (1-based)', () => {
    const r = parse('\ntable 50000 "My Table" {}');
    assert.equal(r.tables[0].declarationLine, 2);
  });

  it('strips UTF-8 BOM', () => {
    const r = parse('\uFEFFtable 1 Foo {}');
    assert.equal(r.tables[0].name, 'Foo');
  });

  it('parses multiple tables in one file', () => {
    const src = [
      'table 1 Alpha { fields {} }',
      'table 2 Beta  { fields {} }'
    ].join('\n');
    const r = parse(src);
    assert.equal(r.tables.length, 2);
    assert.equal(r.tables[0].name, 'Alpha');
    assert.equal(r.tables[1].name, 'Beta');
  });
});

// ---------------------------------------------------------------------------
// Field detection
// ---------------------------------------------------------------------------
describe('parseALFile – fields', () => {
  it('parses fields', () => {
    const src = `table 1 Customer {
  fields {
    field(1; "No."; Code[20]) {}
    field(2; Name; Text[100]) {}
  }
}`;
    const r = parse(src);
    assert.equal(r.tables[0].fields.length, 2);
    assert.equal(r.tables[0].fields[0].name, 'No.');
    assert.equal(r.tables[0].fields[0].dataType, 'Code[20]');
    assert.equal(r.tables[0].fields[1].name, 'Name');
  });

  it('extracts primary key from first key() definition', () => {
    const src = `table 1 SalesLine {
  fields {
    field(1; "Document No."; Code[20]) {}
    field(3; "Line No."; Integer) {}
  }
  keys {
    key(PK; "Document No.","Line No.") { Clustered = true; }
  }
}`;
    const r = parse(src);
    assert.deepEqual(r.tables[0].pkFields, ['Document No.', 'Line No.']);
  });
});

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------
describe('parseALFile – relations', () => {
  it('parses a simple single-line TableRelation', () => {
    const src = `table 37 "Sales Line" {
  fields {
    field(3; "No."; Code[20]) {
      TableRelation = Item;
    }
  }
}`;
    const r = parse(src);
    assert.equal(r.relations.length, 1);
    assert.equal(r.relations[0].sourceTable, 'Sales Line');
    assert.equal(r.relations[0].sourceField, 'No.');
    assert.equal(r.relations[0].targetTable, 'Item');
    assert.equal(r.relations[0].isConditional, false);
  });

  it('parses a quoted target with field', () => {
    const src = `table 37 "Sales Line" {
  fields {
    field(3; "No."; Code[20]) {
      TableRelation = "G/L Account"."No.";
    }
  }
}`;
    const r = parse(src);
    assert.equal(r.relations[0].targetTable, 'G/L Account');
    assert.equal(r.relations[0].targetField, 'No.');
  });

  it('parses multi-line TableRelation', () => {
    const src = `table 37 "Sales Line" {
  fields {
    field(3; "No."; Code[20]) {
      TableRelation =
        "G/L Account";
    }
  }
}`;
    const r = parse(src);
    assert.equal(r.relations.length, 1);
    assert.equal(r.relations[0].targetTable, 'G/L Account');
  });

  it('parses conditional IF/ELSE IF relations', () => {
    const src = `table 37 "Sales Line" {
  fields {
    field(3; "No."; Code[20]) {
      TableRelation = IF (Type = CONST(Item)) Item
                      ELSE IF (Type = CONST("G/L Account")) "G/L Account";
    }
  }
}`;
    const r = parse(src);
    // Two relation targets: first is not conditional, second is
    assert.equal(r.relations.length >= 2, true);
    const tables = r.relations.map(rel => rel.targetTable);
    assert.ok(tables.includes('Item'), `expected Item in ${tables}`);
    assert.ok(tables.includes('G/L Account'), `expected G/L Account in ${tables}`);
    assert.equal(r.relations[1].isConditional, true);
  });

  it('returns relations in ParsedALFile (not on table objects)', () => {
    const src = `table 37 "Sales Line" {
  fields {
    field(3; "No."; Code[20]) { TableRelation = Item; }
  }
}`;
    const r = parse(src);
    // Relations should be in r.relations, not attached as hidden property
    assert.equal(r.relations.length, 1);
    assert.ok(!Object.prototype.hasOwnProperty.call(r.tables[0], '_parsedRelations'),
      'must not have _parsedRelations hidden property');
  });
});

// ---------------------------------------------------------------------------
// Table extensions
// ---------------------------------------------------------------------------
describe('parseALFile – table extensions', () => {
  it('parses a tableextension', () => {
    const src = `tableextension 50100 "Customer Ext" extends Customer {
  fields {
    field(50000; "My Field"; Text[50]) {}
  }
}`;
    const r = parse(src);
    assert.equal(r.tables.length, 0);
    assert.equal(r.extensions.length, 1);
    assert.equal(r.extensions[0].baseName, 'Customer');
    assert.equal(r.extensions[0].extraFields.length, 1);
    assert.equal(r.extensions[0].extraFields[0].name, 'My Field');
  });

  it('parses extension relations into extraRelations', () => {
    const src = `tableextension 50100 "Customer Ext" extends Customer {
  fields {
    field(50000; "Region Code"; Code[10]) {
      TableRelation = Region;
    }
  }
}`;
    const r = parse(src);
    assert.equal(r.extensions[0].extraRelations.length, 1);
    assert.equal(r.extensions[0].extraRelations[0].targetTable, 'Region');
  });
});

// ---------------------------------------------------------------------------
// netBraces edge cases (tested indirectly via parseALFile behaviour)
// ---------------------------------------------------------------------------
describe('parseALFile – brace handling edge cases', () => {
  it('ignores braces that appear after a // comment on the same line', () => {
    // If netBraces counted the `{` in the comment, the parser would think
    // the field body opened a second nesting level and never close properly.
    const src = `table 1 Foo {
  fields {
    field(1; Bar; Integer) { // { this brace is in a comment and must be ignored
      TableRelation = Item;
    }
  }
}`;
    const r = parse(src);
    assert.equal(r.tables.length, 1, 'table should be recognised');
    assert.equal(r.relations.length, 1, 'relation inside the field should be found');
    assert.equal(r.relations[0].targetTable, 'Item');
  });

  it('is not confused by a closing brace inside a // comment', () => {
    // A `}` in a comment must not prematurely close the table block.
    const src = `table 1 Foo {
  fields {
    field(1; Bar; Integer) {
      // } this is fine
      TableRelation = Customer;
    }
  }
}`;
    const r = parse(src);
    assert.equal(r.tables.length, 1);
    assert.equal(r.relations.length, 1);
    assert.equal(r.relations[0].targetTable, 'Customer');
  });
});

// ---------------------------------------------------------------------------
// WHERE / FILTER clause stripping
// ---------------------------------------------------------------------------
describe('parseALFile – WHERE / FILTER clause stripping', () => {
  it('strips WHERE clause and extracts correct target table', () => {
    const src = `table 37 "Sales Line" {
  fields {
    field(3; "No."; Code[20]) {
      TableRelation = Customer WHERE ("No." = FIELD("Sell-to Customer No."));
    }
  }
}`;
    const r = parse(src);
    assert.equal(r.relations.length, 1, 'exactly one relation should be found');
    assert.equal(r.relations[0].targetTable, 'Customer');
    // The WHERE clause tokens must not appear as extra spurious relations
    const targets = r.relations.map(rel => rel.targetTable);
    assert.ok(!targets.includes('CONST'), 'CONST should not be a relation target');
    assert.ok(!targets.includes('FILTER'), 'FILTER should not be a relation target');
  });

  it('strips FILTER clause similarly', () => {
    const src = `table 37 "Sales Line" {
  fields {
    field(3; "No."; Code[20]) {
      TableRelation = Item FILTER("Type" = CONST(Inventory));
    }
  }
}`;
    const r = parse(src);
    assert.equal(r.relations.length, 1);
    assert.equal(r.relations[0].targetTable, 'Item');
  });

  it('handles conditional relation with WHERE on each branch', () => {
    const src = `table 37 "Sales Line" {
  fields {
    field(3; "No."; Code[20]) {
      TableRelation =
        IF (Type = CONST(Item)) Item WHERE (Blocked = CONST(false))
        ELSE IF (Type = CONST("G/L Account")) "G/L Account";
    }
  }
}`;
    const r = parse(src);
    const targets = r.relations.map(rel => rel.targetTable);
    assert.ok(targets.includes('Item'), `expected Item, got: ${targets}`);
    assert.ok(targets.includes('G/L Account'), `expected G/L Account, got: ${targets}`);
    assert.ok(!targets.includes('CONST'), 'CONST must not appear as a target');
  });
});
