import assert from 'assert';
import {
  ArgumentNode,
  BooleanValueNode,
  DirectiveNode,
  GraphQLCompositeType,
  GraphQLEnumType,
  GraphQLNamedType,
  GraphQLObjectType,
  GraphQLOutputType,
  GraphQLScalarType,
  IntValueNode,
  isCompositeType,
  isEnumType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isUnionType,
  ListValueNode,
  ObjectValueNode,
  StringValueNode,
} from 'graphql';
import { singular } from 'pluralize';
import { snakeCase } from 'snake-case';
import {
  Analyzer,
  EnumValueType,
  FieldType,
  isConnectionFieldInfo,
  TableType,
  TableTypeInfo,
  TypeInfo,
} from './Analyzer';
import { defaultConfig, SqlConfig } from './config/SqlConfig';
import { SqlColumn } from './model/SqlColumn';
import { SqlKeyType } from './model/SqlKey';
import { SqlTable } from './model/SqlTable';
import {
  findFirstDirective,
  formatLocationOf,
  getDirectiveArgument,
  getRequiredDirectiveArgument,
  hasDirective,
} from './util/ast-util';

export interface FieldColumns {
  field: FieldType;
  columns: SqlColumn[];
}

export interface FieldJoin {
  field: FieldType;
  toTable: TableMapping;
  fromFields?: FieldType[]; // one:many with backref join
  toFields?: FieldType[]; // one:many
  pkPrefix?: boolean; // many:many: if referring table key is first half of join table key (else last half)
  nodeTable?: TableMapping; // many:many connection
  sequenceColumn?: SqlColumn; // list sequence column
  listColumns?: SqlColumn[]; // scalar list columns
}

export type FieldMapping = FieldColumns | FieldJoin;

export function isColumns(mapping: FieldMapping): mapping is FieldColumns {
  return 'columns' in mapping;
}

export function isJoin(mapping: FieldMapping): mapping is FieldJoin {
  return 'toTable' in mapping;
}

export interface AbstractTableMapping {
  table: SqlTable;
  fieldMappings: Map<FieldType, FieldMapping>;
}

export interface TypeTableMapping extends AbstractTableMapping {
  type: TableType;
}

export interface FieldTableMapping extends AbstractTableMapping {
  containingType: GraphQLCompositeType;
  field: FieldType;
}

export type TableMapping = TypeTableMapping | FieldTableMapping;

export function isTypeTableMapping(mapping: TableMapping): mapping is TypeTableMapping {
  return 'type' in mapping;
}

export interface SqlSchemaMappings {
  tables: readonly TableMapping[];
  getIdentityTableForType(type: TableType): InternalTableMapping<TypeTableMapping> | undefined;
}

enum FieldsMapped {
  NONE,
  SOME_KEYS,
  ALL_KEYS,
  SOME_DATA,
  ALL_DATA,
}

type InternalTableMapping<T extends TableMapping = TableMapping> = T & {
  fieldsMapped: FieldsMapped;
  fieldNames?: Set<string>;
};

type SqlColumnType = { name?: string } & Omit<SqlColumn, 'name'>;

export class SqlSchemaBuilder {
  private readonly config: SqlConfig;
  private readonly tableMappingByName = new Map<string, InternalTableMapping>();
  private readonly identityTableMappingByType = new Map<TableType, InternalTableMapping<TypeTableMapping>>();

  constructor(private readonly analyzer: Analyzer, config?: Partial<SqlConfig>) {
    this.config = Object.assign({}, defaultConfig, config);
  }

  public generateTables(): SqlSchemaMappings {
    for (const typeInfo of this.analyzer.getTypeInfos()) {
      // only directly emit tables with identity fields; non-identity tables are emitted as
      // encountered via fields, since they take their identity from the referencing table
      if (typeInfo.hasTable && typeInfo.hasIdentity) {
        this.generateTable(typeInfo as TypeInfo<TableType>);
      }
    }
    return {
      tables: Array.from(this.tableMappingByName.values()),
      getIdentityTableForType: (type) => this.identityTableMappingByType.get(type),
    };
  }

  private generateTable(typeInfo: TypeInfo<TableType>): InternalTableMapping | null {
    const { type, identityTypeInfo } = typeInfo;

    // return table if already generated for type
    let mapping = this.identityTableMappingByType.get(type);
    if (mapping == null) {
      // get the name of the table based on the type name or @sqlTable.name
      const name = getTableName(type, this.config);
      const existing = this.tableMappingByName.get(name);
      if (existing) {
        let message = `Table name "${name}" for type "${type.name}" already used`;
        if (isTypeTableMapping(existing)) {
          message += `by type "${existing.type.name}"`;
        }
        throw new Error(message);
      }

      const fields = type.getFields();
      const fieldNames = new Set(Object.keys(fields));

      // exclude fields already in interface table
      if (identityTypeInfo) {
        for (const intfFieldName of Object.keys(identityTypeInfo.type.getFields())) {
          fieldNames.delete(intfFieldName);
        }

        // skip table entirely represented by interface table
        if (fieldNames.size === 0) {
          const intfTableName = getTableName(identityTypeInfo.type, this.config);
          const intfTableMapping = this.tableMappingByName.get(intfTableName);
          if (intfTableMapping) {
            this.identityTableMappingByType.set(type, { ...intfTableMapping, type });
          }
          return null;
        }
      }

      mapping = this.emitTypeTable(name, type, fieldNames);
      this.identityTableMappingByType.set(type, mapping);
    } else if (mapping.fieldsMapped >= FieldsMapped.SOME_DATA) {
      return mapping;
    }

    const { table, fieldNames } = mapping;

    if (mapping.fieldsMapped === FieldsMapped.NONE) {
      mapping.fieldsMapped = FieldsMapped.SOME_KEYS;

      // if the table doesn't have an explicit internal ID, add an implicit one
      if (!typeInfo.internalIdFields) {
        // if the table implements an interface table, use its internal ID
        if (identityTypeInfo) {
          const interfaceTable = this.generateTable(identityTypeInfo)!.table;
          this.addParentKeyColumns(table, interfaceTable);
        } else {
          // add an auto-increment column as the internal ID
          const idColumn = {
            name: this.config.internalIdName,
            type: this.config.internalIdSqlType ?? this.config.autoIncrementType,
            notNull: true,
            autoIncrement: true,
          };
          table.columns.push(idColumn);
          table.primaryKey.parts.push({ column: idColumn, descending: false });
        }
      } else {
        // emit primary key fields separately first to support circular references
        for (const field of typeInfo.internalIdFields) {
          const columns = this.emitColumnsForField(mapping, typeInfo, field);
          table.primaryKey.parts.push(...columns.map((column) => ({ column, descending: false })));
          fieldNames!.delete(field.name);
        }
      }

      mapping.fieldsMapped = FieldsMapped.ALL_KEYS;
    }

    if (mapping.fieldsMapped === FieldsMapped.ALL_KEYS) {
      // emit remaining non-key columns
      this.emitColumnsForFields(mapping, typeInfo, fieldNames);

      // add any keys from @sqlTable directive
      const tableDir = findFirstDirective(type, this.config.sqlTableDirective);
      const keysArg = tableDir ? getDirectiveArgument(tableDir, 'keys') : null;
      if (keysArg != null) {
        this.emitKeys(table, keysArg);
      }
      mapping.fieldsMapped = FieldsMapped.ALL_DATA;
    }

    return mapping;
  }

  private newTable(name: string): SqlTable {
    return {
      name,
      columns: [],
      primaryKey: {
        type: SqlKeyType.PRIMARY,
        parts: [],
      },
      keys: [],
      options: { ...this.config.tableOptions },
    };
  }

  private emitTypeTable(
    name: string,
    type: TableType,
    fieldNames?: Set<string>
  ): InternalTableMapping<TypeTableMapping> {
    const table = this.newTable(name);
    const tableId = this.analyzer.getTableId(type);
    if (tableId) {
      table.discriminatorValue = tableId;
    }
    const mapping = {
      type,
      table,
      fieldMappings: new Map(),
      fieldsMapped: FieldsMapped.NONE,
      fieldNames,
    };
    this.tableMappingByName.set(name, mapping);
    return mapping;
  }

  private emitFieldTable(
    name: string,
    containingType: TableType,
    field: FieldType
  ): InternalTableMapping<FieldTableMapping> {
    const table = this.newTable(name);
    const mapping = {
      containingType,
      field,
      table,
      fieldMappings: new Map(),
      fieldsMapped: FieldsMapped.NONE,
    };
    this.tableMappingByName.set(name, mapping);
    return mapping;
  }

  private emitColumnsForFields(
    mapping: InternalTableMapping,
    typeInfo: TypeInfo<TableType>,
    fieldNames?: Iterable<string>
  ): void {
    const fields = typeInfo.type.getFields();
    if (!fieldNames) {
      fieldNames = Object.keys(fields);
    }
    mapping.fieldsMapped = FieldsMapped.SOME_DATA;
    for (const fieldName of fieldNames) {
      this.emitColumnsForField(mapping, typeInfo, fields[fieldName]);
    }
  }

  private emitColumnsForField(
    mapping: InternalTableMapping,
    typeInfo: TypeInfo<TableType>,
    field: FieldType
  ): SqlColumn[] {
    if (hasDirective(field, this.config.derivedDirective)) {
      return [];
    }

    let fieldType = field.type;
    let notNull = false;
    if (isNonNullType(fieldType)) {
      notNull = true;
      fieldType = fieldType.ofType;
    }

    let { name, explicitName } = getColumnNameInfo(field, this.config);

    const { table } = mapping;
    const autoIncrement = hasDirective(field, this.config.autoincDirective);
    let sqlType;
    let charset;
    let collate;
    let srid;
    let uniqueKey = hasDirective(field, this.config.uniqueDirective);
    let typeDir = findFirstDirective(field, this.config.sqlTypeDirective);
    if (typeDir == null && 'astNode' in fieldType) {
      typeDir = findFirstDirective(fieldType, this.config.sqlTypeDirective);
    }
    if (typeDir != null) {
      ({ type: sqlType, charset, collate, srid } = this.getExplicitSqlType(typeDir));
    } else if (isScalarType(fieldType)) {
      ({ name = name, type: sqlType, charset, collate, uniqueKey = uniqueKey } = this.getScalarSqlType(
        fieldType,
        field,
        autoIncrement
      ));
    } else if (isEnumType(fieldType)) {
      ({ type: sqlType, charset, collate } = this.getEnumSqlType(fieldType));
    } else if (isObjectType(fieldType)) {
      const fieldInfo = this.analyzer.findFieldInfo(field);
      if (fieldInfo && isConnectionFieldInfo(fieldInfo)) {
        // one:many or many:many relation following the Relay connection pattern
        const { edgeTypeInfo } = fieldInfo;
        const nodeType = edgeTypeInfo.nodeType!;
        if (!isCompositeType(nodeType)) {
          throw new Error(`Unsupported connection node type "${fieldType.name}"${formatLocationOf(field.astNode)}`);
        }
        const nodeTableMapping = this.getNodeTable(nodeType);

        if (!fieldInfo.hasEdgeTable) {
          // one:many join using back-reference field (node field of this type)
          // or join (node fields corresponding to fields of this type)
          const fieldMapping: FieldJoin = { field, toTable: nodeTableMapping };
          if (fieldInfo.nodeBackrefField) {
            fieldMapping.toFields = [fieldInfo.nodeBackrefField];
          } else {
            fieldMapping.fromFields = fieldInfo.nodeBackrefJoin!.map((pair) => pair[1] || pair[0]);
            fieldMapping.toFields = fieldInfo.nodeBackrefJoin!.map((pair) => pair[0]);
          }
          mapping.fieldMappings.set(field, fieldMapping);
          return [];
        }

        const { relationDirective } = fieldInfo;
        const edgeType = edgeTypeInfo.type as GraphQLObjectType;
        if (relationDirective && relationDirective.name.value === this.config.useManyToManyDirective) {
          // use existing many:many join table created for another field (i.e. the inverse relation)
          const fieldArg = getRequiredDirectiveArgument(relationDirective, 'tableName', 'StringValue');
          const tableName = (fieldArg.value as StringValueNode).value;
          let joinTableMapping = this.tableMappingByName.get(tableName);
          if (!joinTableMapping) {
            joinTableMapping = this.emitTypeTable(tableName, edgeType);
          }
          mapping.fieldMappings.set(field, {
            field,
            toTable: joinTableMapping,
            pkPrefix: false,
            nodeTable: nodeTableMapping,
          });
          return [];
        }

        // create a many:many join table if required by directive, lack of back-reference, or edge fields
        const joinTableMapping = this.getJoinTable(table, typeInfo, field, edgeType);
        if (joinTableMapping.fieldsMapped === FieldsMapped.SOME_KEYS) {
          const { node } = edgeType.getFields();
          ({ name, explicitName } = getColumnNameInfo(node, this.config, snakeCase(nodeType.name)));
          notNull = isNonNullType(node.type);
          const refCols = this.addTypeReferenceColumns(
            joinTableMapping.table,
            nodeType,
            name,
            explicitName,
            notNull,
            uniqueKey
          );
          joinTableMapping.table.primaryKey.parts.push(...refCols.map((column) => ({ column, descending: false })));
          joinTableMapping.fieldsMapped = FieldsMapped.ALL_KEYS;
          const { extraEdgeFields } = edgeTypeInfo;
          if (extraEdgeFields) {
            this.emitColumnsForFields(
              joinTableMapping,
              edgeTypeInfo,
              extraEdgeFields.map((f) => f.name)
            );
          }
          this.emitJoinTableKeys(joinTableMapping.table, field);
          joinTableMapping.fieldsMapped = FieldsMapped.ALL_DATA;
        }
        mapping.fieldMappings.set(field, {
          field,
          toTable: joinTableMapping,
          pkPrefix: true,
          nodeTable: nodeTableMapping,
        });
        return [];
      } else {
        const fieldTypeInfo = this.analyzer.getTypeInfo(fieldType);
        if (fieldTypeInfo.hasIdentity) {
          // for identity tables, reference by internal ID
          const columns = this.addTypeReferenceColumns(table, fieldType, name, explicitName, notNull, uniqueKey);
          mapping.fieldMappings.set(field, { field, columns });
          return columns;
        } else if (fieldTypeInfo.hasData) {
          // create 1:1 join table for nested type with data but no identity
          const joinTableMapping = this.getJoinTable(table, typeInfo, field, fieldType);
          if (joinTableMapping.fieldsMapped === FieldsMapped.SOME_KEYS) {
            joinTableMapping.fieldsMapped = FieldsMapped.ALL_KEYS;
            this.emitColumnsForFields(joinTableMapping, fieldTypeInfo);
            this.emitJoinTableKeys(joinTableMapping.table, field);
            joinTableMapping.fieldsMapped = FieldsMapped.ALL_DATA;
          }
          mapping.fieldMappings.set(field, { field, toTable: joinTableMapping });
        } else {
          // for nested type with no data, associate any connection fields with containing type
          this.emitColumnsForFields(mapping, fieldTypeInfo);
          mapping.fieldMappings.set(field, { field, toTable: mapping });
        }
        return [];
      }
    } else if (isInterfaceType(fieldType) || isUnionType(fieldType)) {
      const columns = this.addTypeReferenceColumns(table, fieldType, name, explicitName, notNull, uniqueKey);
      mapping.fieldMappings.set(field, { field, columns });
      return columns;
    } else if (isListType(fieldType)) {
      let elementType: GraphQLOutputType = fieldType.ofType;
      if (!isNonNullType(elementType)) {
        throw new Error(`Nullable list elements are not supported${formatLocationOf(field.astNode)}`);
      }
      elementType = elementType.ofType;
      if (isListType(elementType)) {
        throw new Error(`Lists of lists are not supported${formatLocationOf(field.astNode)}`);
      }

      const joinTableMapping = this.getJoinTable(table, typeInfo, field);
      assert(joinTableMapping.fieldsMapped === FieldsMapped.SOME_KEYS);
      const joinTable = joinTableMapping.table;

      // if the list is ordered or non-unique, we need a sequence as part of the primary key
      const ordered = !hasDirective(field, this.config.unorderedDirective);
      let sequenceColumn;
      if (ordered || !uniqueKey) {
        sequenceColumn = {
          name: this.config.sequenceName,
          type: this.config.sequenceSqlType,
          notNull: true,
        };
        joinTable.columns.push(sequenceColumn);
        joinTable.primaryKey.parts.push({
          column: sequenceColumn,
          descending: false,
        });
      }

      // list names are usually plural, but the column name should be singular
      if (!explicitName) {
        name = singular(name);
      }

      let keyColumns;
      if (isCompositeType(elementType)) {
        const elementTypeInfo = this.analyzer.getTypeInfo(elementType);
        if (elementTypeInfo.hasIdentity) {
          keyColumns = this.addTypeReferenceColumns(joinTable, elementType, name, explicitName, true, false);
        } else if (isObjectType(elementType)) {
          if (uniqueKey) {
            throw new Error(`@unique not supported for object value lists${formatLocationOf(field.astNode)}`);
          }
          this.emitColumnsForFields(joinTableMapping, elementTypeInfo as TableTypeInfo);
        } else {
          throw new Error(
            `Lists of interfaces or unions without identity are not supported${formatLocationOf(field.astNode)}`
          );
        }
      } else {
        if ('astNode' in elementType) {
          typeDir = findFirstDirective(elementType, this.config.sqlTypeDirective);
        }
        if (typeDir != null) {
          ({ type: sqlType, charset, collate, srid } = this.getExplicitSqlType(typeDir));
        } else if (isScalarType(elementType)) {
          ({ type: sqlType, charset, collate } = this.getScalarSqlType(elementType, field));
        } else {
          ({ type: sqlType, charset, collate } = this.getEnumSqlType(elementType));
        }
        const column: SqlColumn = {
          name,
          type: sqlType,
          charset,
          collate,
          srid,
          notNull: true,
        };
        joinTable.columns.push(column);
        keyColumns = [column];
      }

      if (uniqueKey && keyColumns) {
        const parts = keyColumns.map((column) => ({ column, descending: false }));
        if (!ordered) {
          joinTable.primaryKey.parts = joinTable.primaryKey.parts.concat(parts);
        } else {
          joinTable.keys.push({
            name,
            type: SqlKeyType.UNIQUE,
            parts: joinTable.primaryKey.parts.slice(0, -1).concat(parts),
          });
        }
      }

      this.emitJoinTableKeys(joinTableMapping.table, field);
      joinTableMapping.fieldsMapped = FieldsMapped.ALL_DATA;
      mapping.fieldMappings.set(field, {
        field,
        toTable: joinTableMapping,
        pkPrefix: true,
        sequenceColumn,
        listColumns: keyColumns,
      });
      return [];
    } else {
      throw new Error(`Unrecognized field type: ${(fieldType as GraphQLOutputType).toString()}`);
    }

    const column: SqlColumn = {
      name,
      type: sqlType,
      charset,
      collate,
      srid,
      notNull,
      autoIncrement,
    };
    if (hasDirective(field, this.config.createdAtDirective)) {
      column.default = 'CURRENT_TIMESTAMP';
    }
    if (hasDirective(field, this.config.updatedAtDirective)) {
      column.onUpdate = 'CURRENT_TIMESTAMP';
    }
    table.columns.push(column);
    if (uniqueKey) {
      table.keys.push({
        name,
        type: SqlKeyType.UNIQUE,
        parts: [{ column, descending: false }],
      });
    }
    const columns = [column];
    mapping.fieldMappings.set(field, { field, columns });
    return columns;
  }

  private getExplicitSqlType(typeDir: DirectiveNode): SqlColumnType {
    const typeArg = getRequiredDirectiveArgument(typeDir, 'type', 'StringValue');
    const sqlType = (typeArg.value as StringValueNode).value;
    let charset, collate, srid;
    const charsetArg = getDirectiveArgument(typeDir, 'charset');
    if (charsetArg != null) {
      charset = (charsetArg.value as StringValueNode).value;
    }
    const collateArg = getDirectiveArgument(typeDir, 'collate');
    if (collateArg != null) {
      collate = (collateArg.value as StringValueNode).value;
    }
    const sridArg = getDirectiveArgument(typeDir, 'srid');
    if (sridArg != null) {
      srid = parseInt((sridArg.value as IntValueNode).value, 10);
    }
    return { type: sqlType, charset, collate, srid };
  }

  private getScalarSqlType(type: GraphQLScalarType, field: FieldType, autoIncrement = false): SqlColumnType {
    let name, sqlType, charset, collate, uniqueKey;
    switch (type.name) {
      case 'ID':
        const ridDir = findFirstDirective(field, this.config.randomIdDirective);
        const wkidDir = findFirstDirective(field, this.config.wkidDirective);
        if (ridDir != null) {
          name = this.config.randomIdName;
          sqlType = this.config.randomIdSqlType;
          charset = this.config.randomIdCharset;
          collate = this.config.randomIdCollate;
          uniqueKey = true;
        } else if (wkidDir != null) {
          const maxArg = getRequiredDirectiveArgument(wkidDir, 'maxLength', 'IntValue');
          name = this.config.wkidName;
          sqlType = `varchar(${(maxArg.value as IntValueNode).value})`;
          charset = this.config.wkidCharset;
          collate = this.config.wkidCollate;
          uniqueKey = true;
        } else if (autoIncrement) {
          sqlType = this.config.autoIncrementType;
        } else if (this.config.idSqlType != null) {
          sqlType = this.config.idSqlType;
          charset = this.config.idCharset;
          collate = this.config.idCollate;
        } else {
          throw new Error(
            `@sqlType, @autoinc, @wkid, or @rid directive required for ID type${formatLocationOf(field.astNode)}`
          );
        }
        break;
      case 'String':
        const lengthDir = findFirstDirective(field, this.config.lengthDirective);
        if (lengthDir != null) {
          const maxArg = getRequiredDirectiveArgument(lengthDir, 'max', 'IntValue');
          sqlType = `varchar(${(maxArg.value as IntValueNode).value})`;
        } else {
          sqlType = 'text';
        }
        charset = this.config.tableOptions.defaultCharset;
        collate = this.config.tableOptions.defaultCollate;
        break;
      case 'Float':
        sqlType = 'double';
        break;
      case 'Int':
        sqlType = autoIncrement ? this.config.autoIncrementType : 'int(11)';
        break;
      case 'Boolean':
        sqlType = this.config.booleanSqlType;
        break;
      default:
        throw new Error(
          `@sqlType directive required for custom scalar type "${type.name}"${formatLocationOf(field.astNode)}`
        );
    }
    return { name, type: sqlType, charset, collate, uniqueKey };
  }

  private getEnumSqlType(type: GraphQLEnumType): SqlColumnType {
    let sqlType, charset, collate;
    const typeInfo = this.analyzer.getTypeInfo(type);
    if (typeInfo.valueType === EnumValueType.STRING) {
      sqlType = `varchar(${typeInfo.maxLength})`;
      charset = this.config.tableOptions.defaultCharset;
      collate = this.config.tableOptions.defaultCollate;
    } else if (typeInfo.minIntValue >= 0 && typeInfo.maxIntValue <= 255) {
      sqlType = 'tinyint(3) unsigned';
    } else {
      sqlType = 'int(11)';
    }
    return { type: sqlType, charset, collate };
  }

  private emitKeys(table: SqlTable, keysArg: ArgumentNode): void {
    for (const keyValue of (keysArg.value as ListValueNode).values) {
      const { fields } = keyValue as ObjectValueNode;
      const nameField = fields.find((f) => f.name.value === 'name');
      const keyName = nameField ? (nameField.value as StringValueNode).value : undefined;
      const uniqueField = fields.find((f) => f.name.value === 'unique');
      const unique = uniqueField != null && (uniqueField.value as BooleanValueNode).value;
      const columnsField = fields.find((f) => f.name.value === 'columns');
      if (!columnsField || columnsField.value.kind !== 'ListValue') {
        throw new Error(`Expected ListValue for @${this.config.sqlTableDirective}.columns`);
      }
      const columnNames = (columnsField.value as ListValueNode).values.map((v) => (v as StringValueNode).value);
      const name = keyName || columnNames.join('_');
      if (!table.keys.find((key) => key.name === name)) {
        table.keys.push({
          name,
          type: unique ? SqlKeyType.UNIQUE : SqlKeyType.INDEX,
          parts: columnNames.map((columnName) => {
            let descending = false;
            const parts = columnName.split(' ');
            if (parts.length > 1) {
              columnName = parts[0];
              const direction = parts[1].toLowerCase();
              if (direction === 'desc') {
                descending = true;
              } else if (direction !== 'asc') {
                throw new Error(`Invalid direction for column "${columnName}" of "${table.name}": ${parts[1]}`);
              }
            }
            const column = table.columns.find((column) => column.name === columnName);
            if (column == null) {
              throw new Error(
                `Column "${columnName}" not found in table "${table.name}" for key "${name}"` +
                  `; known columns: ${table.columns.map((column) => column.name).join(', ')}`
              );
            }
            return {
              column,
              descending,
            };
          }),
        });
      }
    }
  }

  private getNodeTable(nodeType: GraphQLCompositeType): InternalTableMapping {
    let typeInfo = this.analyzer.getTypeInfo(nodeType);
    if (typeInfo.identityTypeInfo) {
      typeInfo = typeInfo.identityTypeInfo;
    }
    if (!typeInfo.hasTable) {
      // TODO: support discriminated unions as connection nodes
      const typeKind = isInterfaceType(nodeType) ? 'implementing types' : 'union members';
      throw new Error(`All ${typeKind} of "${nodeType.name}" must have common table interface`);
    }
    return this.generateTable(typeInfo as TypeInfo<TableType>)!;
  }

  private getJoinTable(
    parentTable: SqlTable,
    parentTypeInfo: TypeInfo<TableType>,
    field: FieldType,
    joinType?: TableType
  ): InternalTableMapping {
    let tableName;
    let tableType: TableType | undefined;
    let idPrefix;
    const parentType = parentTypeInfo.type;
    if (joinType) {
      // analyze references to the target type to determine which can share a table
      // 1. references from types sharing a common identity interface can share a table
      // 2. references from multiple interface or concrete types require a table name prefix
      // 3. references from multiple fields within a type also require a table name prefix
      // 4. cases #2 and #3 can each result in a separate table name prefix
      const joinTypeInfo = this.analyzer.getTypeInfo(joinType);
      const fieldCountByRefType = new Map<TableType, number>();
      let nonIdentityInterface = false;
      let multipleIdentityInterfaces = false;
      let foundIdentityInterface = null;
      let foundRef = false;
      let commonIdentityInterface = null;
      for (const ref of joinTypeInfo.referringFields) {
        const { type } = ref;
        const typeRefCount = (fieldCountByRefType.get(type) || 0) + 1;
        fieldCountByRefType.set(type, typeRefCount);

        const refTypeInfo = this.analyzer.getTypeInfo(type);
        const identityInterface = refTypeInfo.identityTypeInfo;
        if (identityInterface) {
          if (commonIdentityInterface == null) {
            commonIdentityInterface = identityInterface;
          } else if (commonIdentityInterface !== identityInterface) {
            multipleIdentityInterfaces = true;
          }
        } else {
          nonIdentityInterface = true;
        }

        if (type === parentType && field === ref.field) {
          foundRef = true;
          foundIdentityInterface = identityInterface;
        }
      }
      assert(foundRef, `Reference not found: ${parentTable.name}.${field.name} -> ${joinType.name}`);
      idPrefix = snakeCase(foundIdentityInterface ? foundIdentityInterface.type.name : parentType.name);
      const needIdentityPrefix = multipleIdentityInterfaces || (nonIdentityInterface && fieldCountByRefType.size > 1);
      const needFieldPrefix = (fieldCountByRefType.get(parentType) || 0) > 1;
      tableName =
        (needIdentityPrefix ? idPrefix + '_' : '') +
        (needFieldPrefix ? snakeCase(field.name) + '_' : '') +
        snakeCase(joinType.name);
      tableType = joinType;
    } else {
      idPrefix = snakeCase(parentType.name);
      tableName = `${idPrefix}_${snakeCase(field.name)}`;
    }

    const nmtmDir = findFirstDirective(field, this.config.newManyToManyDirective);
    if (nmtmDir != null) {
      const fieldArg = getDirectiveArgument(nmtmDir, 'tableName');
      if (fieldArg != null) {
        tableName = (fieldArg.value as StringValueNode).value;
      }
    }

    let childTableMapping = this.tableMappingByName.get(tableName);
    if (!childTableMapping) {
      if (tableType) {
        childTableMapping = this.emitTypeTable(tableName, tableType);
      } else {
        childTableMapping = this.emitFieldTable(tableName, parentType, field);
      }
    }

    // @useManyToMany emits a table without setting its primary key
    if (childTableMapping.fieldsMapped === FieldsMapped.NONE) {
      this.addParentKeyColumns(childTableMapping.table, parentTable, idPrefix);
      childTableMapping.fieldsMapped = FieldsMapped.SOME_KEYS;
    }

    return childTableMapping;
  }

  private emitJoinTableKeys(table: SqlTable, field: FieldType): void {
    const nmtmDir = findFirstDirective(field, this.config.newManyToManyDirective);
    if (nmtmDir != null) {
      const keysArg = getDirectiveArgument(nmtmDir, 'tableKeys');
      if (keysArg != null) {
        this.emitKeys(table, keysArg);
      }
    }
  }

  private addParentKeyColumns(childTable: SqlTable, parentTable: SqlTable, idPrefix?: string): void {
    for (const part of parentTable.primaryKey.parts) {
      let { name, type } = part.column;
      if (name === 'id') {
        name = (idPrefix || parentTable.name) + '_id';
      }
      const childColumn = { name, type, notNull: true };
      childTable.columns.push(childColumn);
      childTable.primaryKey.parts.push({
        column: childColumn,
        descending: false,
      });
    }
  }

  private addTypeReferenceColumns(
    sourceTable: SqlTable,
    targetType: GraphQLCompositeType,
    refName: string,
    explicitName: boolean,
    notNull: boolean,
    uniqueKey: boolean
  ): SqlColumn[] {
    let typeInfo = this.analyzer.getTypeInfo(targetType);
    if (typeInfo.identityTypeInfo) {
      typeInfo = typeInfo.identityTypeInfo;
    }
    if (typeInfo.hasTable) {
      const targetTableMapping = this.generateTable(typeInfo as TypeInfo<TableType>)!;
      return this.addTableReferenceColumns(
        sourceTable,
        targetTableMapping.table,
        refName,
        explicitName,
        notNull,
        uniqueKey
      );
    } else if (typeInfo.tableIds) {
      return this.addDiscriminatedReferenceColumns(
        sourceTable,
        typeInfo.tableIds,
        refName,
        explicitName,
        notNull,
        uniqueKey
      );
    } else {
      throw new Error(
        `Member types of union "${targetType.name}" must have common table interface or @${this.config.sqlTableDirective} IDs`
      );
    }
  }

  private addDiscriminatedReferenceColumns(
    sourceTable: SqlTable,
    targetTables: Map<string, TableType>,
    refName: string,
    explicitName: boolean,
    notNull: boolean,
    uniqueKey: boolean
  ): SqlColumn[] {
    const addedColumns: SqlColumn[] = [];

    const discColumn = {
      name: refName + this.config.tableIdSuffix,
      type: this.config.tableIdSqlType,
      charset: this.config.tableIdCharset,
      collate: this.config.tableIdCollate,
      notNull,
      discriminator: true,
    };
    sourceTable.columns.push(discColumn);
    addedColumns.push(discColumn);

    const refTableMapping = this.generateDiscriminatedTables(targetTables);
    addedColumns.push(
      ...this.addTableReferenceColumns(sourceTable, refTableMapping.table, refName, explicitName, notNull, uniqueKey)
    );

    return addedColumns;
  }

  private generateDiscriminatedTables(targetTables: Map<string, TableType>): InternalTableMapping {
    let refTableMapping = null;
    for (const type of targetTables.values()) {
      const typeInfo = this.analyzer.getTypeInfo(type);
      assert(typeInfo.hasTable);
      const newTableMapping = this.generateTable(typeInfo);
      assert(newTableMapping != null);
      const newTable = newTableMapping!.table;
      if (refTableMapping == null) {
        assert(newTable.primaryKey.parts.length > 0);
        refTableMapping = newTableMapping;
      } else {
        const refTable = refTableMapping.table;
        if (newTable.primaryKey.parts.length !== refTable.primaryKey.parts.length) {
          throw new Error(`Primary key mismatch in union reference between "${newTable.name}" and "${refTable.name}"`);
        }
        for (let i = 0; i < newTable.primaryKey.parts.length; ++i) {
          const newTableColumn = newTable.primaryKey.parts[i].column;
          const refTableColumn = refTable.primaryKey.parts[i].column;
          if (newTableColumn.type !== refTableColumn.type) {
            throw new Error(
              'Primary key column type mismatch in union reference between ' +
                `"${newTable.name}.${newTableColumn.name}" (${newTableColumn.type}) and ` +
                `"${refTable.name}.${refTableColumn.name}" (${refTableColumn.type})`
            );
          }
        }
      }
    }
    assert(refTableMapping);
    return refTableMapping!;
  }

  private addTableReferenceColumns(
    sourceTable: SqlTable,
    targetTable: SqlTable,
    refName: string,
    explicitName: boolean,
    notNull: boolean,
    uniqueKey: boolean
  ): SqlColumn[] {
    const { primaryKey } = targetTable;
    const addedColumns = [];
    if (primaryKey.parts.length === 1) {
      const name = explicitName ? refName : refName + this.config.internalIdSuffix;
      const { type, collate } = primaryKey.parts[0].column;
      const refColumn = { name, type, collate, notNull };
      sourceTable.columns.push(refColumn);
      addedColumns.push(refColumn);
    } else {
      const addPrefix = explicitName || !targetTable.name.startsWith(refName);
      for (const part of primaryKey.parts) {
        let { name, type, collate } = part.column;
        if (addPrefix) {
          name = refName + '_' + name;
        }
        const refColumn = { name, type, collate, notNull };
        sourceTable.columns.push(refColumn);
        addedColumns.push(refColumn);
      }
    }
    if (uniqueKey) {
      sourceTable.keys.push({
        name: addedColumns[0].name,
        type: SqlKeyType.UNIQUE,
        parts: addedColumns.map((column) => ({ column, descending: false })),
      });
    }
    return addedColumns;
  }
}

function getTableName(type: GraphQLNamedType, config: SqlConfig): string {
  const tableDir = findFirstDirective(type, config.sqlTableDirective);
  if (tableDir != null) {
    const nameArg = getDirectiveArgument(tableDir, 'name');
    if (nameArg != null) {
      return (nameArg.value as StringValueNode).value;
    }
  }
  return snakeCase(type.name);
}

function getColumnNameInfo(
  field: FieldType,
  config: SqlConfig,
  defaultName?: string
): { name: string; explicitName: boolean } {
  let name = defaultName;
  let explicitName = false;

  const columnDir = findFirstDirective(field, config.sqlColumnDirective);
  if (columnDir != null) {
    const nameArg = getDirectiveArgument(columnDir, 'name');
    if (nameArg != null) {
      name = (nameArg.value as StringValueNode).value;
      explicitName = true;
    }
  }

  if (!name) {
    const ridDir = findFirstDirective(field, config.randomIdDirective);
    const wkidDir = findFirstDirective(field, config.wkidDirective);
    if (ridDir != null) {
      name = config.randomIdName;
    } else if (wkidDir != null) {
      name = config.wkidName;
    } else {
      name = snakeCase(field.name);
    }
  }

  return { name, explicitName };
}
