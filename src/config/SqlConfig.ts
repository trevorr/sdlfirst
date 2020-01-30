import { defaultConfig as defaultDirectiveConfig, DirectiveConfig } from './DirectiveConfig';
import { defaultConfig as defaultPathConfig, PathConfig } from './PathConfig';
import { SqlTableOptions } from '../model/SqlTable';

export interface SqlConfig extends DirectiveConfig, PathConfig {
  booleanSqlType: string;
  idSqlType?: string;
  idCharset?: string;
  idCollate?: string;

  internalIdName: string;
  internalIdSuffix: string;
  internalIdSqlType: string;
  internalIdAutoIncrement: true;

  randomIdName: string;
  randomIdSqlType: string;
  randomIdCharset?: string;
  randomIdCollate?: string;

  stringIdName: string;
  stringIdCharset?: string;
  stringIdCollate?: string;

  tableIdSuffix: string;
  tableIdSqlType: string;

  tableOptions: SqlTableOptions;
}

export const defaultConfig: SqlConfig = {
  ...defaultDirectiveConfig,
  ...defaultPathConfig,

  booleanSqlType: 'tinyint(1)',
  idSqlType: undefined,
  idCharset: undefined,
  idCollate: undefined,

  internalIdName: 'id',
  internalIdSuffix: '_id',
  internalIdSqlType: 'int(10) unsigned',
  internalIdAutoIncrement: true,

  randomIdName: 'xid',
  randomIdSqlType: 'varchar(21)',
  randomIdCharset: 'utf8mb4',
  randomIdCollate: 'utf8mb4_bin',

  stringIdName: 'sid',
  stringIdCharset: 'utf8mb4',
  stringIdCollate: 'utf8mb4_bin',

  tableIdSuffix: '_kind',
  tableIdSqlType: 'char(1)',

  tableOptions: {
    engine: 'InnoDB',
    defaultCharset: 'utf8mb4',
    defaultCollate: 'utf8mb4_0900_ai_ci'
  }
};
