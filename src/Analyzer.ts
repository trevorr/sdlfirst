import {
  BooleanValueNode,
  DirectiveNode,
  getNullableType,
  GraphQLCompositeType,
  GraphQLEnumType,
  GraphQLField,
  GraphQLInterfaceType,
  GraphQLNullableType,
  GraphQLObjectType,
  GraphQLOutputType,
  GraphQLSchema,
  GraphQLType,
  GraphQLUnionType,
  IntValueNode,
  isEnumType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isUnionType,
  ListValueNode,
  ObjectValueNode,
  StringValueNode
} from 'graphql';
import { pascalCase } from 'pascal-case';
import { defaultConfig, DirectiveConfig } from './config/DirectiveConfig';
import { findFirstDirective, getDirectiveArgument, hasDirective } from './util/ast-util';
import { getElementType, getInterfaceImplementors, InterfaceImplementorMap } from './util/graphql-util';

export type TableType = GraphQLObjectType | GraphQLInterfaceType;
export type AnalyzedType = GraphQLCompositeType | GraphQLEnumType;
export type FieldType = GraphQLField<any, any>;

export interface TypeField {
  readonly type: TableType;
  readonly field: FieldType;
}

export interface TypeInfo<T = AnalyzedType> {
  readonly type: T;
  analyzed: boolean;

  // all fields of analyzed types referring to this type
  referringFields: TypeField[];

  // true iff has data or reference fields or some union member does
  hasData: boolean;

  // true iff has internal or external ID fields or a unique key or all union members have common interface that does
  hasIdentity: boolean;

  // fields with @id directive, if any
  internalIdFields?: FieldType[];

  // field with @sid or @xid directive, if any
  externalIdField?: FieldType;

  // @sid or @xid directive of external ID field, if any
  externalIdDirective?: DirectiveNode;

  // field used to determine concrete type of interface
  typeDiscriminatorField?: FieldType;

  // true iff object or @sqlTable interface
  hasTable: boolean;

  // effective @sqlTable(id) of this type
  tableId?: string | null;

  // type info of @sqlTable interface from which this object or union type gets its identity
  identityTypeInfo?: TypeInfo<GraphQLInterfaceType>;

  // @sqlTable(id) mapping for interface implementers or union members if all have one
  tableIds?: Map<string, TableType>;

  // node type if this is a connection edge type
  nodeType?: GraphQLNullableType;
}

export enum EnumValueType {
  INT,
  STRING
}

export interface EnumTypeInfo extends TypeInfo<GraphQLEnumType> {
  valueType: EnumValueType;
  values: Map<string, string | number>;
  maxLength: number;
  minIntValue: number;
  maxIntValue: number;
  discriminatedInterface?: TypeInfo<GraphQLInterfaceType>;
  discriminatedObjects?: Map<string, TypeInfo<GraphQLObjectType>>;
}

export class Analyzer {
  private readonly config: Readonly<DirectiveConfig>;
  private readonly interfaceImplementors: InterfaceImplementorMap;
  private readonly typeInfos = new Map<AnalyzedType, TypeInfo>();

  constructor(private readonly schema: GraphQLSchema, config?: Partial<DirectiveConfig>) {
    this.config = Object.freeze(Object.assign({}, defaultConfig, config));
    this.interfaceImplementors = getInterfaceImplementors(Object.values(schema.getTypeMap()));
    this.findTableIdFields();
    this.analyzeMembers();
  }

  public getConfig(): Readonly<DirectiveConfig> {
    return this.config;
  }

  public getTypeInfos(): Iterable<TypeInfo> {
    return this.typeInfos.values();
  }

  public findTypeInfo(type: GraphQLEnumType): EnumTypeInfo | undefined;
  public findTypeInfo<T extends AnalyzedType>(type: T): TypeInfo<T> | undefined;
  public findTypeInfo(type: AnalyzedType): TypeInfo | undefined {
    return this.typeInfos.get(type);
  }

  public getTypeInfo(type: GraphQLEnumType): EnumTypeInfo;
  public getTypeInfo<T extends AnalyzedType>(type: T): TypeInfo<T>;
  public getTypeInfo(type: AnalyzedType): TypeInfo {
    let typeInfo = this.findTypeInfo(type);
    if (typeInfo == null) {
      typeInfo = {
        type,
        analyzed: false,
        hasData: false,
        hasIdentity: false,
        hasTable: false,
        referringFields: []
      };
      if (isEnumType(type)) {
        this.analyzeEnum(typeInfo as EnumTypeInfo);
      }
      this.typeInfos.set(type, typeInfo);
    }
    return typeInfo;
  }

  public getIdentityTypeInfo(type: TableType): TypeInfo<TableType> {
    let typeInfo = this.getTypeInfo(type);
    if (typeInfo.identityTypeInfo) {
      typeInfo = typeInfo.identityTypeInfo;
    }
    return typeInfo;
  }

  public isConnectionType(type: GraphQLType): boolean {
    return isObjectType(type) && type.name.endsWith('Connection');
  }

  public isEdgeType(type: GraphQLType): boolean {
    return isObjectType(type) && type.name.endsWith('Edge');
  }

  public getEdgeTypeForConnection(type: GraphQLObjectType): GraphQLObjectType {
    const { edges } = type.getFields();
    if (!edges) {
      throw new Error(`Field "edges" not found on Connection type "${type.name}"`);
    }
    try {
      const edgeType = getElementType(edges.type);
      if (!isObjectType(edgeType)) {
        throw new Error(`Expected GraphQLObjectType elements but got ${type.constructor.name}`);
      }
      return edgeType;
    } catch (e) {
      throw new Error(`Invalid type for field "edges" of Connection type "${type.name}": ${e.message}`);
    }
  }

  public getNodeTypeForConnection(type: GraphQLObjectType): GraphQLOutputType {
    return this.getNodeTypeForEdge(this.getEdgeTypeForConnection(type));
  }

  private getNodeTypeForEdge(edgeType: GraphQLObjectType): GraphQLOutputType {
    const { node } = edgeType.getFields();
    if (!node) {
      throw new Error(`Field "node" not found on Edge type "${edgeType.name}"`);
    }
    return getNullableType(node.type);
  }

  public getImplementingTypes(type: GraphQLInterfaceType): Iterable<GraphQLObjectType> {
    return this.interfaceImplementors.get(type) || [];
  }

  private findTableIdFields(): void {
    const { config, schema } = this;
    for (const type of Object.values(schema.getTypeMap())) {
      // skip introspection types
      if (type.name.startsWith('__')) {
        continue;
      }

      // all non-introspection enums
      if (isEnumType(type)) {
        this.getTypeInfo(type);
        continue;
      }

      // skip query, mutation, connection, edge, and SQL types
      if (
        type === schema.getQueryType() ||
        type === schema.getMutationType() ||
        this.isConnectionType(type) ||
        this.isEdgeType(type) ||
        hasDirective(type, config.sqlTypeDirective)
      ) {
        continue;
      }

      if (isObjectType(type)) {
        const typeInfo = this.findIdFields(type);
        typeInfo.hasTable = true;
        typeInfo.tableId = this.getTableId(type);
      } else if (isInterfaceType(type)) {
        const typeInfo = this.findIdFields(type);
        if (hasDirective(type, config.sqlTableDirective)) {
          if (!typeInfo.hasIdentity) {
            throw new Error(`@${config.sqlTableDirective} interface "${type.name}" must have an ID field`);
          }
          typeInfo.hasTable = true;
          typeInfo.tableId = this.getTableId(type);
        }
      }
    }
  }

  private findIdFields(type: TableType): TypeInfo<TableType> {
    const { config } = this;
    const typeInfo = this.getTypeInfo(type);
    for (const field of Object.values(type.getFields())) {
      let foundId = false;
      const idDir = findFirstDirective(field, config.internalIdDirective);
      if (idDir) {
        if (typeInfo.internalIdFields != null) {
          typeInfo.internalIdFields.push(field);
        } else {
          typeInfo.internalIdFields = [field];
        }
        foundId = true;
      }
      const xidDir = findFirstDirective(field, config.externalIdDirective);
      const sidDir = findFirstDirective(field, config.stringIdDirective);
      if (xidDir || sidDir) {
        if (xidDir && sidDir) {
          throw new Error(
            `Cannot specify both @${config.externalIdDirective} and ` +
              `@${config.stringIdDirective} on ${type.name}.${field.name}`
          );
        }
        if (!isScalarType(getNullableType(field.type))) {
          throw new Error(`Scalar type expected for external ID field: ${type.name}.${field.name}`);
        }
        if (typeInfo.externalIdField != null) {
          throw new Error(`Duplicate external ID field: ${type.name}.${field.name}`);
        }
        typeInfo.externalIdField = field;
        typeInfo.externalIdDirective = xidDir || sidDir;
        foundId = true;
      }
      if (foundId) {
        if (!isNonNullType(field.type)) {
          throw new Error(`ID field must be non-null: ${type.name}.${field.name}`);
        }
        typeInfo.hasIdentity = true;
      }
    }
    // also consider a unique key as an identity
    if (!typeInfo.hasIdentity) {
      const tableDir = findFirstDirective(type, config.sqlTableDirective);
      if (tableDir != null) {
        const keysArg = getDirectiveArgument(tableDir, 'keys');
        if (keysArg != null) {
          typeInfo.hasIdentity = (keysArg.value as ListValueNode).values.some(v =>
            (v as ObjectValueNode).fields.some(f => f.name.value === 'unique' && (f.value as BooleanValueNode).value)
          );
        }
      }
    }
    return typeInfo;
  }

  private analyzeMembers(): void {
    for (const [type, typeInfo] of this.typeInfos.entries()) {
      if (isObjectType(type)) {
        // check for implemented interface tables
        const intfTables = this.getInterfaceTables(type);
        switch (intfTables.length) {
          case 0:
            // type implements no interface tables
            break;
          case 1:
            (typeInfo as TypeInfo<TableType>).identityTypeInfo = intfTables[0];
            break;
          default:
            throw new Error(
              `Type "${type.name}" cannot implement multiple table interfaces: ` +
                intfTables.map(i => i.type.name).join(', ')
            );
        }

        this.analyzeFields(type);
      } else if (isInterfaceType(type)) {
        // check for @sqlTable IDs on implementors
        if (!(typeInfo as TypeInfo<TableType>).hasTable) {
          const impls = this.interfaceImplementors.get(type);
          if (impls) {
            const tableIds = this.getTableIds(impls);
            if (tableIds != null) {
              (typeInfo as TypeInfo<TableType>).tableIds = tableIds;
            }
          }
        }

        this.analyzeFields(type);
      } else if (isUnionType(type)) {
        this.analyzeUnion(type);
      }
    }
  }

  private getInterfaceTables(type: GraphQLObjectType): TypeInfo<GraphQLInterfaceType>[] {
    const result = [];
    for (const intf of type.getInterfaces()) {
      const intfInfo = this.findTypeInfo(intf);
      if (intfInfo && intfInfo.hasTable) {
        result.push(intfInfo);
      }
    }
    return result;
  }

  private analyzeFields(type: TableType): TypeInfo<TableType> {
    const typeInfo = this.getTypeInfo(type);
    if (!typeInfo.analyzed) {
      typeInfo.analyzed = true;
      for (const field of Object.values(type.getFields())) {
        this.analyzeField(typeInfo, field, field.type);
      }
    }
    return typeInfo;
  }

  private analyzeField(typeInfo: TypeInfo<TableType>, field: FieldType, fieldType: GraphQLOutputType): void {
    const { type } = typeInfo;
    fieldType = getNullableType(fieldType);
    if (isScalarType(fieldType)) {
      typeInfo.hasData = true; // a value
    } else if (isEnumType(fieldType)) {
      typeInfo.hasData = true; // a value
      const tdDir = findFirstDirective(field, this.config.typeDiscriminatorDirective);
      if (tdDir && isInterfaceType(type)) {
        this.analyzeTypeDiscriminator(fieldType, typeInfo as TypeInfo<GraphQLInterfaceType>);
        typeInfo.typeDiscriminatorField = field;
      }
    } else if (isObjectType(fieldType)) {
      if (this.isConnectionType(fieldType)) {
        this.analyzeConnectionType(fieldType).referringFields.push({
          type,
          field
        });
      } else if (!hasDirective(type, this.config.sqlTypeDirective)) {
        const fieldTypeInfo = this.analyzeFields(fieldType);
        fieldTypeInfo.referringFields.push({ type, field });
        if (fieldTypeInfo.hasIdentity) {
          typeInfo.hasData = true; // an ID
        }
      } else {
        typeInfo.hasData = true; // a value
      }
    } else if (isInterfaceType(fieldType)) {
      if (hasDirective(fieldType, this.config.sqlTableDirective)) {
        this.analyzeFields(fieldType).referringFields.push({ type, field });
      }
      typeInfo.hasData = true; // an ID
    } else if (isUnionType(fieldType)) {
      const fieldTypeInfo = this.analyzeUnion(fieldType);
      if (fieldTypeInfo.identityTypeInfo) {
        // if the type's identity comes from a another type, use it as the union target
        fieldTypeInfo.identityTypeInfo.referringFields.push({ type, field });
      } else {
        // otherwise link to all tables in the union
        for (const member of fieldType.getTypes()) {
          this.analyzeFields(member).referringFields.push({ type, field });
        }
      }
      typeInfo.hasData = true; // an ID and possibly discriminator
    } else if (isListType(fieldType)) {
      this.analyzeField(typeInfo, field, fieldType.ofType);
    } else {
      throw new Error(`Unrecognized field type: ${(fieldType as GraphQLOutputType).toString()}`);
    }
  }

  private analyzeTypeDiscriminator(type: GraphQLEnumType, intfTypeInfo: TypeInfo<GraphQLInterfaceType>): EnumTypeInfo {
    const typeInfo = this.getTypeInfo(type);
    if (!typeInfo.discriminatedInterface) {
      typeInfo.discriminatedInterface = intfTypeInfo;
      const intfType = intfTypeInfo.type;
      const typeMap = (typeInfo.discriminatedObjects = new Map());
      for (const value of type.getValues()) {
        const { name } = value;
        const typeName = pascalCase(name);
        const objType = this.schema.getType(typeName);
        if (!isObjectType(objType)) {
          throw new Error(`Object type "${typeName}" not found for type discriminator value "${type.name}.${name}"`);
        }
        if (!objType.getInterfaces().includes(intfType)) {
          throw new Error(
            `Object type "${typeName}" of type discriminator "${type.name}" does not implement interface "${intfType.name}"`
          );
        }
        typeMap.set(name, this.getTypeInfo(objType));
      }
    } else if (typeInfo.discriminatedInterface !== intfTypeInfo) {
      throw new Error(
        `Enum type "${type.name}" is already a type discriminator for interface "${typeInfo.discriminatedInterface.type.name}"`
      );
    }
    return typeInfo;
  }

  private analyzeConnectionType(connectionType: GraphQLObjectType): TypeInfo {
    const edgeType = this.getEdgeTypeForConnection(connectionType);
    const edgeTypeInfo = this.getTypeInfo(edgeType);
    if (!edgeTypeInfo.analyzed) {
      edgeTypeInfo.analyzed = true;

      // get node type
      const { cursor, node, ...rest } = edgeType.getFields();
      if (!node) {
        throw new Error(`Field "node" not found on Edge type "${edgeType.name}"`);
      }
      const nodeType = (edgeTypeInfo.nodeType = getNullableType(node.type));

      // if optional nodes list is present, ensure type matches edges node
      const { nodes } = connectionType.getFields();
      if (nodes) {
        let connectionNodeType;
        try {
          connectionNodeType = getElementType(nodes.type);
        } catch (e) {
          throw new Error(`Invalid type for field "nodes" of Connection type "${connectionType.name}": ${e.message}`);
        }
        if (connectionNodeType !== nodeType) {
          throw new Error(`Element type of "${connectionType.name}.nodes" must match type of "${edgeType.name}.node"`);
        }
      }

      // analyze edge fields except 'cursor' and 'node'
      for (const field of Object.values(rest)) {
        this.analyzeField(edgeTypeInfo, field, field.type);
      }
    }
    return edgeTypeInfo;
  }

  public getRelationDirective(field: FieldType): DirectiveNode | null {
    const otmDir = findFirstDirective(field, this.config.oneToManyDirective);
    const nmtmDir = findFirstDirective(field, this.config.newManyToManyDirective);
    const umtmDir = findFirstDirective(field, this.config.useManyToManyDirective);
    const dirCount = (otmDir ? 1 : 0) + (nmtmDir ? 1 : 0) + (umtmDir ? 1 : 0);
    if (dirCount > 1) {
      throw new Error(`At most one relation directive allowed on Connection field "${field.name}"`);
    }
    return otmDir || nmtmDir || umtmDir || null;
  }

  public findNodeBackrefField(nodeType: GraphQLOutputType, refType: TableType, refField: FieldType): FieldType | null {
    let backrefField: FieldType | null = null;
    let backrefFieldCount = 0;
    nodeType = getNullableType(nodeType);
    if (isObjectType(nodeType) || isInterfaceType(nodeType)) {
      // is there a valid @oneToMany(backrefField) directive?
      const otmDir = findFirstDirective(refField, this.config.oneToManyDirective);
      if (otmDir != null) {
        const fieldArg = getDirectiveArgument(otmDir, 'backrefField');
        if (fieldArg != null) {
          const fieldName = (fieldArg.value as StringValueNode).value;
          const field = nodeType.getFields()[fieldName];
          if (field == null) {
            throw new Error(
              `One-to-many back-reference field "${fieldName}" not found in node type "${nodeType.name}" for "${refType.name}.${refField.name}"`
            );
          }
          if (!this.isIdentifiedBy(field.type, refType)) {
            throw new Error(
              `Referring type "${refType.name}" is not assignable to one-to-many back-reference field "${nodeType.name}.${fieldName}"`
            );
          }
          return field;
        }
      }

      // is there exactly one way to refer back to the referring type from the fields of the node type?
      // if so, we'll assume that is how the one-to-many relation is defined
      for (const field of Object.values(nodeType.getFields())) {
        if (this.isIdentifiedBy(field.type, refType)) {
          backrefField = field;
          ++backrefFieldCount;
        }
      }
    }
    return backrefFieldCount === 1 ? backrefField : null;
  }

  public getNodeBackrefJoin(
    nodeType: GraphQLOutputType,
    refType: TableType,
    refField: FieldType
  ): [FieldType, FieldType][] | null {
    nodeType = getNullableType(nodeType);
    if (isObjectType(nodeType) || isInterfaceType(nodeType)) {
      const otmDir = findFirstDirective(refField, this.config.oneToManyDirective);
      if (otmDir != null) {
        const joinArg = getDirectiveArgument(otmDir, 'backrefJoin');
        if (joinArg != null) {
          const pairs: string[][] = (joinArg.value as ListValueNode).values.map(lv =>
            (lv as ListValueNode).values.map(sv => (sv as StringValueNode).value)
          );
          if (pairs.length === 0) {
            throw new Error(
              `Non-empty field pairs expected in one-to-many back-reference join for "${refType.name}.${refField.name}"`
            );
          }
          const result: [FieldType, FieldType][] = [];
          for (let i = 0; i < pairs.length; ++i) {
            const pair = pairs[i];
            if (pair.length < 1 || pair.length > 2) {
              throw new Error(
                `1 or 2 field names expected at position ${i + 1} in one-to-many back-reference join for "${
                  refType.name
                }.${refField.name}"`
              );
            }
            const [nodeFieldName, refJoinFieldName = nodeFieldName] = pair;
            const nodeField = nodeType.getFields()[nodeFieldName];
            if (nodeField == null) {
              throw new Error(
                `One-to-many back-reference join field "${nodeFieldName}" not found in node type "${nodeType.name}" for "${refType.name}.${refField.name}"`
              );
            }
            const refJoinField = refType.getFields()[refJoinFieldName];
            if (refJoinField == null) {
              throw new Error(
                `One-to-many back-reference join field "${refJoinFieldName}" not found in referring type "${refType.name}" for "${refField.name}"`
              );
            }
            result.push([nodeField, refJoinField]);
          }
          return result;
        }
      }
    }
    return null;
  }

  private isIdentifiedBy(targetType: GraphQLOutputType, sourceType: TableType): boolean {
    targetType = getNullableType(targetType);
    if (this.isAssignable(targetType, sourceType)) {
      return true;
    }
    // IT <~ IT2 where IT2 has no identity and IT3 contains sole reference(s) to IT2 and id(IT) <~ id(IT3)
    if (isObjectType(targetType) || isInterfaceType(targetType)) {
      const containingType = this.findContainingIdentityTable(sourceType);
      if (containingType != null) {
        const identityType = this.getIdentityTypeInfo(targetType).type;
        return this.isIdentifiedBy(identityType, containingType);
      }
    }
    return false;
  }

  private isAssignable(targetType: GraphQLNullableType, sourceType: TableType): boolean {
    // T <- T
    if (targetType === sourceType) {
      return true;
    }
    // T | T2 | T3 <- T | T2 (every source type is assignable to some target type)
    if (isUnionType(targetType)) {
      const targetTypes = targetType.getTypes();
      const sourceTypes = isUnionType(sourceType) ? sourceType.getTypes() : [sourceType];
      return sourceTypes.every(sourceType => targetTypes.some(targetType => this.isAssignable(targetType, sourceType)));
    }
    if (isInterfaceType(targetType)) {
      // I <- T impl I (target type is an interface implemented by source type)
      if (isObjectType(sourceType) && sourceType.getInterfaces().includes(targetType)) {
        return true;
      }
      // I <- I2 where all I2 implementers implement I
      if (isInterfaceType(sourceType)) {
        const impls = this.interfaceImplementors.get(sourceType);
        if (impls && Array.from(impls).every(impl => impl.getInterfaces().includes(targetType))) {
          return true;
        }
      }
    }
    return false;
  }

  private analyzeUnion(type: GraphQLUnionType): TypeInfo<GraphQLUnionType> {
    const typeInfo = this.getTypeInfo(type);
    if (!typeInfo.analyzed) {
      typeInfo.analyzed = true;

      // validate union members and determine intersection of implemented interfaces
      let commonIntfs: Set<GraphQLInterfaceType> | null = null;
      for (const member of type.getTypes()) {
        if (this.isConnectionType(member)) {
          throw new Error(`Union (${type.name}) of Connection type (${member.name}) is unsupported`);
        }
        if (this.isEdgeType(member)) {
          throw new Error(`Union (${type.name}) of Edge type (${member.name}) is unsupported`);
        }
        if (hasDirective(type, this.config.sqlTypeDirective)) {
          throw new Error(`Union (${type.name}) of SQL type (${member.name}) is unsupported`);
        }
        if (this.analyzeFields(member).hasData) {
          typeInfo.hasData = true;
        }
        const intfs = new Set(member.getInterfaces());
        if (!commonIntfs) {
          commonIntfs = intfs;
        } else {
          for (const intf of Array.from(commonIntfs)) {
            if (!intfs.has(intf)) {
              commonIntfs.delete(intf);
            }
          }
        }
      }

      // determine whether there is exactly one common interface that is a table providing the identity
      let tableInterface;
      let tableInterfaceCount = 0;
      if (commonIntfs && commonIntfs.size > 0) {
        for (const intf of commonIntfs) {
          const intfTypeInfo = this.getTypeInfo(intf);
          if (intfTypeInfo.hasIdentity) {
            typeInfo.hasIdentity = true;
          }
          if (intfTypeInfo.hasTable) {
            tableInterface = intfTypeInfo;
            ++tableInterfaceCount;
          }
        }
      }
      if (tableInterfaceCount === 1) {
        typeInfo.identityTypeInfo = tableInterface;
      } else {
        // check for @sqlTable IDs on alternatives (or their interface tables)
        const tableIds = this.getTableIds(type.getTypes());
        if (tableIds != null) {
          typeInfo.tableIds = tableIds;
        }
      }
    }
    return typeInfo;
  }

  private getTableIds(types: Iterable<GraphQLObjectType>): Map<string, TableType> | null {
    let tableIds: Map<string, TableType> | null = new Map();
    for (const type of types) {
      const [tableId, tableType] = this.getEffectiveTableId(type);
      if (tableId != null && tableIds != null) {
        const existing = tableIds.get(tableId);
        if (existing != null && existing !== tableType) {
          throw new Error(
            `Conflicting types for @${this.config.sqlTableDirective} ID "${tableId}": ` +
              `"${existing.name}" and "${tableType.name}"`
          );
        }
        tableIds.set(tableId, tableType);
      } else {
        tableIds = null;
      }
    }
    return tableIds;
  }

  public getTableId(type: TableType): string | null {
    return this.getEffectiveTableId(type)[0];
  }

  private getEffectiveTableId(type: TableType): [string | null, TableType] {
    let tableId = this.getDeclaredTableId(type);
    let tableType: TableType = type;
    if (tableId == null && isObjectType(type)) {
      const intfTables = this.getInterfaceTables(type);
      if (intfTables.length === 1) {
        tableId = this.getDeclaredTableId((tableType = intfTables[0].type));
      }
    }
    return [tableId, tableType];
  }

  private getDeclaredTableId(type: TableType): string | null {
    const tableDir = findFirstDirective(type, this.config.sqlTableDirective);
    if (tableDir != null) {
      const idArg = getDirectiveArgument(tableDir, 'id');
      if (idArg != null) {
        return (idArg.value as StringValueNode).value;
      }
    }
    return null;
  }

  private findContainingIdentityTable(type: TableType): TableType | null {
    let containingTypeInfo = null;
    let containingTypeCount = 0;
    const typeInfo = this.findTypeInfo(type);
    if (typeInfo && !typeInfo.hasIdentity && typeInfo.referringFields.length > 0) {
      for (const ref of typeInfo.referringFields) {
        const refType = ref.type;
        const refTypeInfo = this.getIdentityTypeInfo(refType);
        if (!containingTypeInfo || containingTypeInfo !== refTypeInfo) {
          containingTypeInfo = refTypeInfo;
          ++containingTypeCount;
        }
      }
    }
    return containingTypeInfo && containingTypeCount === 1 ? containingTypeInfo.type : null;
  }

  private analyzeEnum(typeInfo: EnumTypeInfo): void {
    let hasStringValue = false;
    const values = new Map<string, string | number>();
    let maxLength = 0;
    let minIntValue = Infinity;
    let maxIntValue = -Infinity;
    for (const value of typeInfo.type.getValues()) {
      const valueDir = findFirstDirective(value, this.config.sqlValueDirective);
      let sqlValue = value.name;
      let isInt = false;
      if (valueDir != null) {
        const intArg = getDirectiveArgument(valueDir, 'int');
        const stringArg = getDirectiveArgument(valueDir, 'string');
        if (intArg != null) {
          sqlValue = (intArg.value as IntValueNode).value;
          isInt = true;
          const intValue = parseInt(sqlValue, 10);
          values.set(value.name, intValue);
          if (intValue < minIntValue) {
            minIntValue = intValue;
          }
          if (intValue > maxIntValue) {
            maxIntValue = intValue;
          }
        } else if (stringArg != null) {
          sqlValue = (stringArg.value as StringValueNode).value;
        }
      }
      maxLength = Math.max(maxLength, sqlValue.length);
      if (!isInt) {
        hasStringValue = true;
        values.set(value.name, sqlValue);
      }
    }

    typeInfo.analyzed = true;
    typeInfo.valueType = hasStringValue ? EnumValueType.STRING : EnumValueType.INT;
    typeInfo.values = values;
    typeInfo.maxLength = maxLength;
    typeInfo.minIntValue = minIntValue;
    typeInfo.maxIntValue = maxIntValue;
  }
}
