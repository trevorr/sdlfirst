import { SqlColumn } from './SqlColumn';

export enum SqlKeyType {
  INDEX,
  PRIMARY,
  UNIQUE,
  SPATIAL,
  FULLTEXT,
}

export interface SqlKeyPart {
  column: SqlColumn;
  length?: number;
  descending: boolean;
}

export interface SqlKey {
  name?: string;
  type: SqlKeyType;
  parts: SqlKeyPart[];
}

export function formatKey(key: SqlKey): string {
  let sql = '';
  switch (key.type) {
    case SqlKeyType.PRIMARY:
      sql = 'PRIMARY ';
      break;
    case SqlKeyType.UNIQUE:
      sql = 'UNIQUE ';
      break;
    case SqlKeyType.SPATIAL:
      sql = 'SPATIAL ';
      break;
    case SqlKeyType.FULLTEXT:
      sql = 'FULLTEXT ';
      break;
  }
  sql += 'KEY ';
  if (key.name) {
    sql += `\`${key.name}\` `;
  }
  sql += '(';
  let firstPart = true;
  for (const part of key.parts) {
    if (!firstPart) {
      sql += ',';
    } else {
      firstPart = false;
    }
    sql += `\`${part.column.name}\``;
    if (part.length != null) {
      sql += `(${part.length})`;
    }
    if (part.descending) {
      sql += ' DESC';
    }
  }
  return (sql += ')');
}
