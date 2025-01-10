import {
  ConstDirectiveNode,
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
  isCompositeType,
  isEnumType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isUnionType,
  ListValueNode,
  StringValueNode,
} from 'graphql';
import { pascalCase } from 'pascal-case';
import { defaultConfig, DirectiveConfig } from './config/DirectiveConfig';
import { findDirective, getDirectiveArgument, hasDirective } from './util/ast-util';
import { getErrorMessage } from './util/error';
import { getElementType, getInterfaceImplementors, InterfaceImplementorMap } from './util/graphql-util';

export type TableType = GraphQLObjectType | GraphQLInterfaceType;
export type AnalyzedType = GraphQLCompositeType | GraphQLEnumType;
export type FieldType = GraphQLField<any, any>;

export function isTableType(type: any): type is TableType {
  return isObjectType(type) || isInterfaceType(type);
}

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

  // true iff has internal or external ID fields or all union members have common interface that does
  hasIdentity: boolean;

  // fields with @id directive, if any
  internalIdFields?: FieldType[];

  // field with @autoinc directive, if any
  autoincField?: FieldType;

  // field with @wkid or @rid directive, if any
  externalIdField?: FieldType;

  // @wkid or @rid directive of external ID field, if any
  externalIdDirective?: ConstDirectiveNode;

  // field used to determine concrete type of interface
  typeDiscriminatorField?: FieldType;

  // field indicating whether object has been deleted
  softDeleteField?: FieldType;

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

  // fields aside from node and cursor if this is a connection edge type
  extraEdgeFields?: FieldType[];
}

export type TableTypeInfo = TypeInfo<TableType>;

export enum EnumValueType {
  INT,
  STRING,
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

export interface ConnectionFieldInfo extends TypeField {
  edgeTypeInfo: TypeInfo<GraphQLObjectType>;
  relationDirective?: DirectiveNode;
  nodeBackrefField?: FieldType;
  nodeBackrefJoin?: [FieldType, FieldType][];
  hasEdgeTable?: boolean; // for many-to-many or edge data
}

export function isConnectionFieldInfo(info: TypeField): info is ConnectionFieldInfo {
  return 'edgeTypeInfo' in info;
}

export class Analyzer {
  private readonly config: Readonly<DirectiveConfig>;
  private readonly interfaceImplementors: InterfaceImplementorMap;
  private readonly typeInfos = new Map<AnalyzedType, TypeInfo>();
  private readonly fieldInfos = new Map<FieldType, TypeField>();

  constructor(private readonly schema: GraphQLSchema, config?: Partial<DirectiveConfig>) {
    this.config = Object.freeze(Object.assign({}, defaultConfig, config));
    this.interfaceImplementors = getInterfaceImplementors(Object.values(schema.getTypeMap()));
    this.findTableIdFields();
    this.analyzeMembers();
  }

  public getConfig(): Readonly<DirectiveConfig> {
    return this.config;
  }

  public findFieldInfo(field: FieldType): TypeField | undefined {
    const fieldInfo = this.fieldInfos.get(field);
    if (fieldInfo && isConnectionFieldInfo(fieldInfo)) {
      // defer connection field analysis until all other fields are analyzed,
      // since findContainingIdentityTable requires complete referring fields
      this.analyzeConnectionField(fieldInfo);
    }
    return fieldInfo;
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
        referringFields: [],
      };
      if (isEnumType(type)) {
        this.analyzeEnum(typeInfo as EnumTypeInfo);
      }
      this.typeInfos.set(type, typeInfo);
    }
    return typeInfo;
  }

  private getIdentityTypeInfo(type: TableType): TableTypeInfo;
  private getIdentityTypeInfo(type: GraphQLCompositeType): TypeInfo<GraphQLCompositeType>;
  private getIdentityTypeInfo(type: TableType): TableTypeInfo {
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
      throw new Error(`Invalid type for field "edges" of Connection type "${type.name}": ${getErrorMessage(e)}`);
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
      } else if (isInterfaceType(type)) {
        const typeInfo = this.findIdFields(type);
        if (hasDirective(type, config.sqlTableDirective)) {
          if (!typeInfo.hasIdentity) {
            throw new Error(`@${config.sqlTableDirective} interface "${type.name}" must have an ID field`);
          }
          typeInfo.hasTable = true;
        }
      }
    }

    // need second pass in case object types inherit table ID from interface encountered later
    for (const [type, typeInfo] of this.typeInfos) {
      if (typeInfo.hasTable) {
        typeInfo.tableId = this.getTableId(type as TableType);
      }
    }
  }

  private findIdFields(type: TableType): TableTypeInfo {
    const { config } = this;
    const typeInfo = this.getTypeInfo(type);
    for (const field of Object.values(type.getFields())) {
      let foundId = false;

      const hasId = hasDirective(field, config.idDirective);
      if (hasId) {
        if (isListType(getNullableType(field.type))) {
          throw new Error(`Non-list type expected for ID field ${type.name}.${field.name}`);
        }
        if (typeInfo.internalIdFields != null) {
          typeInfo.internalIdFields.push(field);
        } else {
          typeInfo.internalIdFields = [field];
        }
        foundId = true;
      }

      const hasAutoinc = hasDirective(field, config.autoincDirective);
      const ridDir = findDirective(field, config.randomIdDirective);
      const wkidDir = findDirective(field, config.wkidDirective);
      const dirCount = (hasAutoinc ? 1 : 0) + (ridDir ? 1 : 0) + (wkidDir ? 1 : 0);
      if (dirCount > 1) {
        throw new Error(
          `Only one of @${config.autoincDirective}, @${config.randomIdDirective}, ` +
            `or @${config.wkidDirective} allowed on ${type.name}.${field.name}`
        );
      }

      if (hasAutoinc) {
        const fieldType = getNullableType(field.type);
        if (
          !isNonNullType(field.type) ||
          !isScalarType(fieldType) ||
          (fieldType.name !== 'ID' && fieldType.name !== 'Int')
        ) {
          throw new Error(`Auto-increment field ${type.name}.${field.name} must have type ID! or Int!`);
        }
        if (typeInfo.autoincField != null) {
          throw new Error(`Only one @${config.autoincDirective} field allowed in type ${type.name}`);
        }
        typeInfo.autoincField = field;
      }

      if (ridDir || wkidDir) {
        if (!isScalarType(getNullableType(field.type))) {
          throw new Error(`Scalar type expected for external ID field ${type.name}.${field.name}`);
        }
        if (typeInfo.externalIdField != null) {
          throw new Error(
            `Only one @${config.randomIdDirective} or @${config.wkidDirective} field allowed in type ${type.name}`
          );
        }
        typeInfo.externalIdField = field;
        typeInfo.externalIdDirective = ridDir || wkidDir;
        foundId = true;
      }

      if (foundId) {
        if (!isNonNullType(field.type)) {
          throw new Error(`ID field ${type.name}.${field.name} must be non-null`);
        }
        typeInfo.hasIdentity = true;
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
            (typeInfo as TableTypeInfo).identityTypeInfo = intfTables[0];
            break;
          default:
            throw new Error(
              `Type "${type.name}" cannot implement multiple table interfaces: ` +
                intfTables.map((i) => i.type.name).join(', ')
            );
        }

        this.analyzeFields(type);
      } else if (isInterfaceType(type)) {
        // check for @sqlTable IDs on implementors
        if (!(typeInfo as TableTypeInfo).hasTable) {
          const impls = this.interfaceImplementors.get(type);
          if (impls) {
            const tableIds = this.getTableIds(impls);
            if (tableIds != null) {
              (typeInfo as TableTypeInfo).tableIds = tableIds;
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

  private analyzeFields(type: TableType): TableTypeInfo {
    const typeInfo = this.getTypeInfo(type);
    if (!typeInfo.analyzed) {
      typeInfo.analyzed = true;
      for (const field of Object.values(type.getFields())) {
        this.analyzeField(typeInfo, field, field.type);
      }
    }
    return typeInfo;
  }

  private analyzeField(typeInfo: TableTypeInfo, field: FieldType, fieldType: GraphQLOutputType): void {
    if (hasDirective(field, this.config.derivedDirective)) return;

    const { type } = typeInfo;
    const nullableFieldType = getNullableType(fieldType);

    if (hasDirective(field, this.config.typeDiscriminatorDirective)) {
      if (!isInterfaceType(type)) {
        throw new Error(`Non-interface type "${type.name}" cannot have a @typeDiscriminator field`);
      }
      if (!isEnumType(nullableFieldType)) {
        throw new Error(`Non-enum field "${type.name}.${field.name}" cannot use @typeDiscriminator`);
      }
      if (typeInfo.typeDiscriminatorField) {
        throw new Error(`Type "${type.name}" cannot have more than one @typeDiscriminator field`);
      }
      this.analyzeTypeDiscriminator(nullableFieldType, typeInfo as TypeInfo<GraphQLInterfaceType>);
      typeInfo.typeDiscriminatorField = field;
    }

    if (hasDirective(field, this.config.softDeleteDirective)) {
      if (!isSoftDeleteType(fieldType)) {
        throw new Error(`Field "${type.name}.${field.name}" of type "${fieldType.toString()}" cannot use @softDelete`);
      }
      if (typeInfo.softDeleteField) {
        throw new Error(`Type "${type.name}" cannot have more than one @softDelete field`);
      }
      typeInfo.softDeleteField = field;
    }

    if (isScalarType(nullableFieldType)) {
      typeInfo.hasData = true; // a value
    } else if (isEnumType(nullableFieldType)) {
      typeInfo.hasData = true; // a value
    } else if (isObjectType(nullableFieldType)) {
      if (this.isConnectionType(nullableFieldType)) {
        this.analyzeConnection(type, field, nullableFieldType).referringFields.push({
          type,
          field,
        });
      } else if (this.isEdgeType(nullableFieldType)) {
        // analyzed as part of associated connection
      } else if (hasDirective(type, this.config.sqlTypeDirective)) {
        typeInfo.hasData = true; // a value
      } else {
        const fieldTypeInfo = this.analyzeFields(nullableFieldType);
        fieldTypeInfo.referringFields.push({ type, field });
        if (fieldTypeInfo.hasIdentity) {
          typeInfo.hasData = true; // an ID
        }
      }
    } else if (isInterfaceType(nullableFieldType)) {
      if (hasDirective(nullableFieldType, this.config.sqlTableDirective)) {
        this.analyzeFields(nullableFieldType).referringFields.push({ type, field });
      }
      typeInfo.hasData = true; // an ID
    } else if (isUnionType(nullableFieldType)) {
      const fieldTypeInfo = this.analyzeUnion(nullableFieldType);
      if (fieldTypeInfo.identityTypeInfo) {
        // if the type's identity comes from a another type, use it as the union target
        fieldTypeInfo.identityTypeInfo.referringFields.push({ type, field });
      } else {
        // otherwise link to all tables in the union
        for (const member of nullableFieldType.getTypes()) {
          this.analyzeFields(member).referringFields.push({ type, field });
        }
      }
      typeInfo.hasData = true; // an ID and possibly discriminator
    } else if (isListType(nullableFieldType)) {
      this.analyzeField(typeInfo, field, nullableFieldType.ofType);
    } else {
      throw new Error(`Unrecognized field type: ${(nullableFieldType as GraphQLOutputType).toString()}`);
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

  private analyzeConnection(type: TableType, field: FieldType, connectionType: GraphQLObjectType): TypeInfo {
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
          throw new Error(
            `Invalid type for field "nodes" of Connection type "${connectionType.name}": ${getErrorMessage(e)}`
          );
        }
        if (connectionNodeType !== nodeType) {
          throw new Error(`Element type of "${connectionType.name}.nodes" must match type of "${edgeType.name}.node"`);
        }
      }

      // analyze edge fields except 'cursor' and 'node'
      const extraEdgeFields = Object.values(rest);
      if (extraEdgeFields.length > 0) {
        edgeTypeInfo.extraEdgeFields = extraEdgeFields;
        for (const field of extraEdgeFields) {
          this.analyzeField(edgeTypeInfo, field, field.type);
        }
      }
    }

    const fieldInfo: ConnectionFieldInfo = { type, field, edgeTypeInfo };
    this.fieldInfos.set(field, fieldInfo);

    return edgeTypeInfo;
  }

  private analyzeConnectionField(fieldInfo: ConnectionFieldInfo): void {
    const { type, field, edgeTypeInfo } = fieldInfo;
    const otmDir = findDirective(field, this.config.oneToManyDirective);
    const nmtmDir = findDirective(field, this.config.newManyToManyDirective);
    const umtmDir = findDirective(field, this.config.useManyToManyDirective);
    const dirCount = (otmDir ? 1 : 0) + (nmtmDir ? 1 : 0) + (umtmDir ? 1 : 0);
    if (dirCount > 1) {
      throw new Error(`At most one relation directive allowed on Connection field "${type.name}.${field.name}"`);
    }
    fieldInfo.relationDirective = otmDir || nmtmDir || umtmDir;

    const { nodeType } = edgeTypeInfo;
    if (otmDir) {
      if (!isTableType(nodeType)) {
        throw new Error(`@${this.config.oneToManyDirective} requires object or interface node type`);
      }
      if (edgeTypeInfo.extraEdgeFields) {
        throw new Error(
          `@${this.config.oneToManyDirective} cannot be used with edge fields aside from "node" and "cursor"`
        );
      }
      fieldInfo.nodeBackrefField = this.lookupNodeBackrefField(type, field, nodeType, otmDir);
      fieldInfo.nodeBackrefJoin = this.lookupNodeBackrefJoin(type, field, nodeType, otmDir);
      if (fieldInfo.nodeBackrefField && fieldInfo.nodeBackrefJoin) {
        throw new Error(`Cannot specify both backrefField and backrefJoin on field "${type.name}.${field.name}"`);
      }
      if (!fieldInfo.nodeBackrefField && !fieldInfo.nodeBackrefJoin) {
        fieldInfo.nodeBackrefField = this.findNodeBackrefField(type, nodeType);
      }
      // if no backref field or join, assume user will join manually
      fieldInfo.hasEdgeTable = false;
    } else {
      if (!nmtmDir && !umtmDir && isTableType(nodeType) && !edgeTypeInfo.extraEdgeFields) {
        fieldInfo.nodeBackrefField = this.findNodeBackrefField(type, nodeType);
      }
      fieldInfo.hasEdgeTable = !fieldInfo.nodeBackrefField;
    }
  }

  private lookupNodeBackrefField(
    refType: TableType,
    refField: FieldType,
    nodeType: TableType,
    otmDir: DirectiveNode
  ): FieldType | undefined {
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
          `Referring type "${refType.name}" is not assignable to one-to-many back-reference field` +
            ` "${nodeType.name}.${fieldName}" of type "${field.type.toString()}"`
        );
      }
      if (field.args.some((arg) => isNonNullType(arg.type))) {
        throw new Error(`One-to-many back-reference field "${fieldName}" cannot have non-null arguments`);
      }
      return field;
    }
  }

  private findNodeBackrefField(refType: TableType, nodeType: TableType): FieldType | undefined {
    let backrefField: FieldType | undefined;
    let backrefFieldCount = 0;

    // is there exactly one way to refer back to the referring type from the fields of the node type?
    // if so, we'll assume that is how the one-to-many relation is defined
    for (const field of Object.values(nodeType.getFields())) {
      if (this.isIdentifiedBy(field.type, refType) && !field.args.some((arg) => isNonNullType(arg.type))) {
        backrefField = field;
        ++backrefFieldCount;
      }
    }

    return backrefFieldCount === 1 ? backrefField : undefined;
  }

  private lookupNodeBackrefJoin(
    refType: TableType,
    refField: FieldType,
    nodeType: TableType,
    otmDir: DirectiveNode
  ): [FieldType, FieldType][] | undefined {
    const joinArg = getDirectiveArgument(otmDir, 'backrefJoin');
    if (joinArg != null) {
      const pairs: string[][] = (joinArg.value as ListValueNode).values.map((lv) =>
        (lv as ListValueNode).values.map((sv) => (sv as StringValueNode).value)
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
            `1 or 2 field names expected at position ${i + 1} in one-to-many back-reference join for "${refType.name}.${
              refField.name
            }"`
          );
        }
        const [nodeFieldName, refJoinFieldName = nodeFieldName] = pair;
        const nodeField = nodeType.getFields()[nodeFieldName];
        if (nodeField == null) {
          throw new Error(
            `One-to-many back-reference join field "${nodeFieldName}" not found in node type "${nodeType.name}" for "${refType.name}.${refField.name}"`
          );
        }
        if (nodeField.args.some((arg) => isNonNullType(arg.type))) {
          throw new Error(`One-to-many back-reference join field "${nodeFieldName}" cannot have non-null arguments`);
        }
        const refJoinField = refType.getFields()[refJoinFieldName];
        if (refJoinField == null) {
          throw new Error(
            `One-to-many back-reference join field "${refJoinFieldName}" not found in referring type "${refType.name}" for "${refField.name}"`
          );
        }
        if (refJoinField.args.some((arg) => isNonNullType(arg.type))) {
          throw new Error(`One-to-many back-reference join field "${refJoinFieldName}" cannot have non-null arguments`);
        }
        result.push([nodeField, refJoinField]);
      }
      return result;
    }
  }

  private isIdentifiedBy(targetType: GraphQLOutputType, sourceType: TableType): boolean {
    targetType = getNullableType(targetType);
    if (this.isAssignable(targetType, sourceType)) {
      return true;
    }
    // IT <~ IT2 where IT2 has no identity and IT3 contains sole reference(s) to IT2 and id(IT) <~ id(IT3)
    if (isCompositeType(targetType)) {
      const identityType = this.getIdentityTypeInfo(targetType).type;
      if (isTableType(identityType)) {
        const containingType = this.findContainingIdentityTable(sourceType);
        if (containingType != null) {
          return this.isIdentifiedBy(identityType, containingType);
        }
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
      const sourceTypes: readonly TableType[] = isUnionType(sourceType) ? sourceType.getTypes() : [sourceType];
      return sourceTypes.every((sourceType) =>
        targetTypes.some((targetType) => this.isAssignable(targetType, sourceType))
      );
    }
    if (isInterfaceType(targetType)) {
      // I <- T impl I (target type is an interface implemented by source type)
      if (isObjectType(sourceType) && sourceType.getInterfaces().includes(targetType)) {
        return true;
      }
      // I <- I2 where all I2 implementers implement I
      if (isInterfaceType(sourceType)) {
        const impls = this.interfaceImplementors.get(sourceType);
        if (impls && Array.from(impls).every((impl) => impl.getInterfaces().includes(targetType))) {
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
    const tableDir = findDirective(type, this.config.sqlTableDirective);
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
    let transform: string | null = null;
    const valuesDir = findDirective(typeInfo.type, this.config.sqlValuesDirective);
    if (valuesDir != null) {
      const transformArg = getDirectiveArgument(valuesDir, 'transform');
      if (transformArg != null) {
        transform = (transformArg.value as StringValueNode).value;
      }
    }
    for (const value of typeInfo.type.getValues()) {
      const valueDir = findDirective(value, this.config.sqlValueDirective);
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
      } else if (transform != null) {
        switch (transform) {
          case 'LOWERCASE':
            sqlValue = sqlValue.toLowerCase();
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

function isSoftDeleteType(type: GraphQLType): boolean {
  const nonNull = isNonNullType(type);
  const nullableType = getNullableType(type);
  if (isScalarType(nullableType)) {
    switch (nullableType.name) {
      case 'Boolean':
        return nonNull;
      case 'Date':
      case 'DateTime':
        return !nonNull;
    }
  }
  return false;
}
