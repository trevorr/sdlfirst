import { expect } from 'chai';
import { buildSchema } from 'graphql';
import { Analyzer } from '../src/Analyzer';
import { SqlSchemaBuilder } from '../src/SqlSchemaBuilder';
import { formatTable } from '../src/model/SqlTable';

function schemaTables(sdl: string): string[] {
  return new SqlSchemaBuilder(new Analyzer(buildSchema(sdl)))
    .generateTables()
    .tables.map((t) => formatTable(t.table))
    .sort();
}

describe('SqlSchemaBuilder', () => {
  it('basically works', () => {
    const tables = schemaTables(`
      directive @rid on FIELD_DEFINITION
      type A { id: ID! @rid, b: B }
      type B { x: String }
    `);
    expect(tables).to.eql([
      `CREATE TABLE \`a\` (
  \`id\` int(10) unsigned NOT NULL AUTO_INCREMENT,
  \`rid\` varchar(21) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`rid\` (\`rid\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`,
      `CREATE TABLE \`b\` (
  \`a_id\` int(10) unsigned NOT NULL,
  \`x\` text,
  PRIMARY KEY (\`a_id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`,
    ]);
  });

  it('handles M:N connections with implicit edge table', () => {
    const tables = schemaTables(`
      directive @rid on FIELD_DEFINITION
      type A { id: ID! @rid, bs: BConnection! }
      type B { id: ID! @rid }
      type BEdge { cursor: String!, node: B! }
      type BConnection {
        edges: [BEdge!]!
        nodes: [B!]!
        totalCount: Int!
      }
    `);
    expect(tables).to.eql([
      `CREATE TABLE \`a\` (
  \`id\` int(10) unsigned NOT NULL AUTO_INCREMENT,
  \`rid\` varchar(21) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`rid\` (\`rid\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`,
      `CREATE TABLE \`b_edge\` (
  \`a_id\` int(10) unsigned NOT NULL,
  \`b_id\` int(10) unsigned NOT NULL,
  PRIMARY KEY (\`a_id\`,\`b_id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`,
      `CREATE TABLE \`b\` (
  \`id\` int(10) unsigned NOT NULL AUTO_INCREMENT,
  \`rid\` varchar(21) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`rid\` (\`rid\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`,
    ]);
  });

  it('handles M:N connections with explicit join table via backref field', () => {
    const tables = schemaTables(`
      directive @id on FIELD_DEFINITION
      directive @rid on FIELD_DEFINITION
      directive @oneToMany(backrefField: String) on FIELD_DEFINITION
      type Person {
        id: ID! @rid
        connectedTo: SocialConnection! @oneToMany(backrefField: "from")
        connectedFrom: SocialConnection! @oneToMany(backrefField: "to")
      }
      type SocialGraph { from: Person! @id to: Person! @id }
      type SocialEdge { cursor: String!, node: SocialGraph! }
      type SocialConnection {
        edges: [SocialEdge!]!
        nodes: [SocialGraph!]!
        totalCount: Int!
      }
    `);
    expect(tables).to.eql([
      `CREATE TABLE \`person\` (
  \`id\` int(10) unsigned NOT NULL AUTO_INCREMENT,
  \`rid\` varchar(21) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`rid\` (\`rid\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`,
      `CREATE TABLE \`social_graph\` (
  \`from_id\` int(10) unsigned NOT NULL,
  \`to_id\` int(10) unsigned NOT NULL,
  PRIMARY KEY (\`from_id\`,\`to_id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
`,
    ]);
  });
});
