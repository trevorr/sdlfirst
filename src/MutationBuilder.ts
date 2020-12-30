import fs from 'fs';
import {
  ArgumentNode,
  assertScalarType,
  buildASTSchema,
  DirectiveNode,
  getNamedType,
  getNullableType,
  GraphQLBoolean,
  GraphQLCompositeType,
  GraphQLField,
  GraphQLFieldConfig,
  GraphQLInputFieldConfig,
  GraphQLInputObjectType,
  GraphQLInputType,
  GraphQLList,
  GraphQLNamedType,
  GraphQLNonNull,
  GraphQLNullableType,
  GraphQLObjectType,
  GraphQLObjectTypeConfig,
  GraphQLScalarType,
  GraphQLSchema,
  GraphQLString,
  GraphQLType,
  InputValueDefinitionNode,
  isCompositeType,
  isEnumType,
  isInputObjectType,
  isInputType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isUnionType,
  ListTypeNode,
  ListValueNode,
  NamedTypeNode,
  NameNode,
  NonNullTypeNode,
  parse,
  StringValueNode,
  TypeNode,
} from 'graphql';
import path from 'path';
import { plural, singular } from 'pluralize';
import { Memoize } from 'typescript-memoize';
import { Analyzer, isConnectionFieldInfo, TypeInfo } from './Analyzer';
import { DirectiveConfig } from './config/DirectiveConfig';
import {
  findFirstDirective,
  getDirectiveArgument,
  getRequiredDirectiveArgument,
  hasDirectiveFlag,
  hasDirectives,
} from './util/ast-util';
import { joinCamelCase, lcFirst, mapLast, splitCamelCase, ucFirst } from './util/case';
import { compare } from './util/compare';
import { unwrapType, WrapperType, wrapType } from './util/graphql-util';

type FieldType = GraphQLField<any, any>;

interface FieldDesc {
  name: string;
  type: GraphQLInputType;
  directive?: DirectiveNode;
}

export const CLIENT_MUTATION_ID = 'clientMutationId';
export const DELETED_FLAG = 'deleted';
const DEFAULT_MUTATION_TYPE_NAME = 'Mutation';

export class MutationBuilder {
  private readonly config: DirectiveConfig;
  private readonly mutationTypeName: string;
  private readonly createTypes: Map<GraphQLObjectType, GraphQLInputObjectType | null> = new Map();
  private readonly updateTypes: Map<GraphQLObjectType, GraphQLInputObjectType | null> = new Map();
  private readonly deleteTypes: Map<GraphQLObjectType, GraphQLInputObjectType | null> = new Map();
  private readonly nestedTypes: Map<string, GraphQLInputObjectType | null> = new Map();

  constructor(private readonly schema: GraphQLSchema, private readonly analyzer: Analyzer) {
    this.config = analyzer.getConfig();
    this.mutationTypeName = schema.getMutationType()?.name ?? DEFAULT_MUTATION_TYPE_NAME;
  }

  public addMutations(): GraphQLSchema {
    const schemaConfig = this.schema.toConfig();
    let mutationConfig: GraphQLObjectTypeConfig<any, any>;
    const { mutation } = schemaConfig;
    if (mutation) {
      mutationConfig = mutation.toConfig();
      delete mutationConfig.astNode;
      schemaConfig.types = schemaConfig.types.filter((type) => type !== mutation);
    } else {
      mutationConfig = {
        name: DEFAULT_MUTATION_TYPE_NAME,
        description: 'Automatically generated mutations',
        fields: {},
      };
    }
    const crudMutations = this.generateMutations(Object.keys(mutationConfig.fields));
    mutationConfig.fields = Object.fromEntries(Object.entries(mutationConfig.fields).concat(crudMutations));
    schemaConfig.mutation = new GraphQLObjectType(mutationConfig);

    // ensure resulting schema includes input directives not used by original schema
    const directivesSource = fs.readFileSync(path.join(path.dirname(__dirname), 'sdl', 'directives.graphql'), {
      encoding: 'utf8',
    });
    const directivesAst = parse(directivesSource);
    const directivesSchema = buildASTSchema(directivesAst);
    const existingDirectiveNames = new Set(schemaConfig.directives.map((d) => d.name));
    schemaConfig.directives = schemaConfig.directives.concat(
      directivesSchema.getDirectives().filter((d) => !existingDirectiveNames.has(d.name))
    );

    return new GraphQLSchema(schemaConfig);
  }

  public generateMutations(existingFields: string[]): [string, GraphQLFieldConfig<any, any>][] {
    const existingSet = new Set(existingFields);
    const fields: [string, GraphQLFieldConfig<any, any>][] = [];
    for (const typeInfo of this.analyzer.getTypeInfos()) {
      if (this.isConcreteEntityTable(typeInfo)) {
        const { type } = typeInfo;
        // TODO: @create
        const createName = `create${type.name}`;
        if (!existingSet.has(createName)) {
          const createType = this.getCreateType(type);
          if (createType) {
            fields.push([
              `create${type.name}`,
              {
                type: new GraphQLNonNull(
                  new GraphQLObjectType({
                    name: `Create${type.name}Payload`,
                    description: `Automatically generated output type for ${this.mutationTypeName}.create${type.name}`,
                    fields: {
                      [CLIENT_MUTATION_ID]: { type: GraphQLString },
                      [lcFirst(type.name)]: { type: new GraphQLNonNull(type) },
                    },
                  })
                ),
                args: { input: { type: new GraphQLNonNull(createType) } },
              },
            ]);
          }
        }
        // TODO: @update
        const updateName = `update${type.name}`;
        if (!existingSet.has(updateName)) {
          const updateType = this.getUpdateType(type);
          if (updateType) {
            fields.push([
              updateName,
              {
                type: new GraphQLNonNull(
                  new GraphQLObjectType({
                    name: `Update${type.name}Payload`,
                    description: `Automatically generated output type for ${this.mutationTypeName}.update${type.name}`,
                    fields: {
                      [CLIENT_MUTATION_ID]: { type: GraphQLString },
                      [lcFirst(type.name)]: { type: new GraphQLNonNull(type) },
                    },
                  })
                ),
                args: { input: { type: new GraphQLNonNull(updateType) } },
              },
            ]);
          }
        }
        // TODO: @delete
        const deleteName = `delete${type.name}`;
        if (!existingSet.has(deleteName)) {
          const deleteType = this.getDeleteType(type);
          if (deleteType) {
            fields.push([
              deleteName,
              {
                type: new GraphQLNonNull(
                  new GraphQLObjectType({
                    name: `Delete${type.name}Payload`,
                    description: `Automatically generated output type for ${this.mutationTypeName}.delete${type.name}`,
                    fields: {
                      [CLIENT_MUTATION_ID]: { type: GraphQLString },
                      [DELETED_FLAG]: { type: new GraphQLNonNull(GraphQLBoolean) },
                    },
                  })
                ),
                args: { input: { type: new GraphQLNonNull(deleteType) } },
              },
            ]);
          }
        }
      }
    }
    return fields.sort((a, b) => compare(a[0], b[0]));
  }

  private isConcreteEntityTable(typeInfo: TypeInfo): typeInfo is TypeInfo<GraphQLObjectType> {
    return isObjectType(typeInfo.type) && typeInfo.hasIdentity; // not an interface table or nested/1:1 table
  }

  private getCreateType(type: GraphQLObjectType): GraphQLInputObjectType | null {
    let createType = this.createTypes.get(type);
    if (createType === undefined) {
      createType = this.makeCreateType(type);
      this.createTypes.set(type, createType);
    }
    return createType;
  }

  private makeCreateType(type: GraphQLObjectType, nestedName?: string): GraphQLInputObjectType | null {
    const nested = nestedName != null;
    const baseName = nestedName ?? type.name;
    const name = `Create${baseName}Input`;
    const existingType = this.schema.getType(name);
    if (existingType) {
      if (!isInputObjectType(existingType)) {
        throw new Error(`Generated input type ${name} conflicts with existing non-input type`);
      }
      return existingType;
    }
    if (nested) {
      const existingInput = this.nestedTypes.get(name);
      if (existingInput) return existingInput;
    }

    const fields = Object.values(type.getFields()).flatMap((field) => this.getCreateInputFields(field, type, baseName));
    if (!fields.length) return null;

    if (!nested) {
      fields.unshift(makeInputFieldConfigEntry(CLIENT_MUTATION_ID, GraphQLString));
    }

    const description = `Automatically generated input type for ${this.mutationTypeName}.create${type.name}`;
    const result = makeInputObjectType(name, description, fields);
    if (nested) {
      this.nestedTypes.set(name, result);
    }
    return result;
  }

  private getCreateInputFields(
    field: FieldType,
    parentType: GraphQLObjectType,
    baseName: string
  ): [string, GraphQLInputFieldConfig][] {
    const result: [string, GraphQLInputFieldConfig][] = [];

    if (!this.includeInCreate(field)) {
      return result;
    }

    const { name } = field;
    let { type } = field;
    let nonNull = false;
    if (isNonNullType(type)) {
      type = type.ofType;
      nonNull = !this.hasDefault(field);
    }
    const wrapped = unwrapType(type);
    let namedType = wrapped.type;
    let isList = wrapped.wrappers.length > 0;
    const addResult = (inputType: GraphQLInputType, inputDir?: DirectiveNode, fieldName = name): void => {
      inputType = wrapType(inputType, wrapped.wrappers) as GraphQLInputType;
      if (nonNull) {
        inputType = new GraphQLNonNull(inputType);
      }
      result.push(makeInputFieldConfigEntry(fieldName, inputType, inputDir && [inputDir]));
    };

    // treat connections as non-null lists if they are many-to-many or have a nested create directive
    const createDir = findFirstDirective(field, this.config.createNestedDirective);
    const fieldInfo = this.analyzer.findFieldInfo(field);
    let edgeType: GraphQLObjectType | undefined;
    let extraEdgeFields: FieldType[] | undefined;
    if (fieldInfo && isConnectionFieldInfo(fieldInfo)) {
      const { edgeTypeInfo } = fieldInfo;
      const { nodeType } = edgeTypeInfo;
      if (
        (fieldInfo.nodeBackrefField && !createDir) ||
        fieldInfo.nodeBackrefJoin ||
        !nodeType ||
        !this.isInputNodeType(nodeType)
      ) {
        return result;
      }
      nonNull = false;
      namedType = getNamedType(nodeType);
      isList = true;
      wrapped.wrappers = [WrapperType.NON_NULL, WrapperType.LIST];
      edgeType = edgeTypeInfo.type;
      if (edgeTypeInfo.extraEdgeFields) {
        extraEdgeFields = edgeTypeInfo.extraEdgeFields.filter((f) => this.includeInCreate(f));
      }
    }

    if (createDir) {
      const inputArg = getDirectiveArgument(createDir, 'input');
      const thisArg = getDirectiveArgument(createDir, 'this');
      if (inputArg) {
        const inputTypeName = (inputArg.value as StringValueNode).value;
        const foundType = this.schema.getType(inputTypeName);
        if (!foundType) {
          throw new Error(`Cannot find input type "${inputTypeName}" for field "${parentType.name}.${field.name}"`);
        }
        if (!isInputType(foundType)) {
          throw new Error(`Invalid input type "${inputTypeName}" for field "${parentType.name}.${field.name}"`);
        }
        addResult(foundType);
      } else if (thisArg) {
        const thisFieldName = (thisArg.value as StringValueNode).value;
        if (!isObjectType(namedType)) {
          throw new Error(
            `Object type required for field "${parentType.name}.${field.name}" with @${this.config.createNestedDirective}.this`
          );
        }
        const excludeArg = getDirectiveArgument(createDir, 'exclude');
        const excludeSet = new Set<string>(
          excludeArg ? (excludeArg.value as ListValueNode).values.map((v) => (v as StringValueNode).value) : []
        );
        const objType = namedType;
        const nestedName = baseName + ucFirst(field.name);
        const fields = Object.values(objType.getFields())
          .filter((f) => f.name !== thisFieldName && !excludeSet.has(f.name))
          .flatMap((f) => this.getCreateInputFields(f, objType, nestedName));
        if (!fields.length) {
          throw new Error(
            `No nested fields found for field "${parentType.name}.${field.name}" with @${this.config.createNestedDirective}.this`
          );
        }
        addResult(
          makeInputObjectType(
            `Create${nestedName}Input`,
            `Automatically generated input type for creation of ${parentType.name}.${field.name}`,
            fields
          )
        );
      } else {
        throw new Error(
          `\`input\` or \`this\` field required for @${this.config.createNestedDirective} on field "${parentType.name}.${field.name}"`
        );
      }
    } else if (isCompositeType(namedType)) {
      const typeInfo = this.analyzer.getTypeInfo(namedType);
      if (typeInfo.hasIdentity || !isObjectType(namedType)) {
        try {
          if (!isList) {
            return toConfigEntries(this.getIdRefFields(namedType, nonNull, name));
          } else {
            const idRefs = this.getIdRefFields(namedType, false);

            // create ref/edge input object only if multiple IDs or extra edge fields
            if (idRefs.length > 1 || extraEdgeFields?.length) {
              addResult(this.makeIdRefType(namedType, idRefs, edgeType, extraEdgeFields));
            }

            // if only one ID and no required edge fields, emit a shorthand ID-list field
            if (idRefs.length === 1 && (!extraEdgeFields || !this.containsRequiredFields(extraEdgeFields))) {
              // connection field "theFoos" with node ID field "barId" becomes "theFooBarIds"
              const idsName = joinCamelCase(
                mapLast(splitCamelCase(name), singular).concat(mapLast(splitCamelCase(idRefs[0].name), plural))
              );
              addResult(idRefs[0].type, idRefs[0].directive, idsName);
            }
          }
        } catch (e) {
          throw new Error(`${e.message} for field "${parentType.name}.${field.name}"`);
        }
      } else {
        const nestedType = this.makeCreateType(namedType, `Nested${namedType.name}`);
        if (nestedType) {
          addResult(nestedType);
        }
      }
    } else {
      addResult(namedType, findFirstDirective(field, this.config.wkidDirective));
    }

    return result;
  }

  private getUpdateType(type: GraphQLObjectType): GraphQLInputObjectType | null {
    let updateType = this.updateTypes.get(type);
    if (updateType === undefined) {
      updateType = this.makeUpdateType(type);
      this.updateTypes.set(type, updateType);
    }
    return updateType;
  }

  private makeUpdateType(type: GraphQLObjectType, nestedName?: string): GraphQLInputObjectType | null {
    const nested = nestedName != null;
    const baseName = nestedName ?? type.name;
    const name = `Update${baseName}Input`;
    const existingType = this.schema.getType(name);
    if (existingType) {
      if (!isInputObjectType(existingType)) {
        throw new Error(`Generated input type ${name} conflicts with existing type`);
      }
      return existingType;
    }
    if (nested) {
      const existingInput = this.nestedTypes.get(name);
      if (existingInput) return existingInput;
    }

    const fields = Object.values(type.getFields()).flatMap((field) => this.getUpdateInputFields(field, type));
    if (!fields.length) return null;

    if (!nested) {
      fields.unshift(...toConfigEntries(this.getIdRefFields(type, true)));
      fields.unshift(makeInputFieldConfigEntry(CLIENT_MUTATION_ID, GraphQLString));
    }

    const description = `Automatically generated input type for ${this.mutationTypeName}.update${type.name}`;
    const result = new GraphQLInputObjectType({
      name,
      description,
      fields: Object.fromEntries(fields),
      astNode: {
        kind: 'InputObjectTypeDefinition',
        name: makeNameNode(name),
        description: {
          kind: 'StringValue',
          value: description,
          block: true,
        },
        fields: fields.map((f) => f[1].astNode!),
      },
    });
    if (nested) {
      this.nestedTypes.set(name, result);
    }
    return result;
  }

  private getUpdateInputFields(field: FieldType, parentType: GraphQLObjectType): [string, GraphQLInputFieldConfig][] {
    const result: [string, GraphQLInputFieldConfig][] = [];

    if (!this.includeInUpdate(field)) {
      return result;
    }

    const { name } = field;
    let { type } = field;
    if (isNonNullType(type)) {
      type = type.ofType;
    }
    const wrapped = unwrapType(type);
    let namedType = wrapped.type;
    let isList = wrapped.wrappers.length > 0;
    const addResult = (inputType: GraphQLInputType, inputDir?: DirectiveNode, fieldName = name): void => {
      inputType = wrapType(inputType, wrapped.wrappers) as GraphQLInputType;
      result.push(makeInputFieldConfigEntry(fieldName, inputType, inputDir && [inputDir]));
    };

    // treat connections as non-null lists if they are many-to-many or have a nested update directive
    const updateDir = findFirstDirective(field, this.config.updateNestedDirective);
    const fieldInfo = this.analyzer.findFieldInfo(field);
    let edgeType: GraphQLObjectType | undefined;
    let extraEdgeFields: FieldType[] | undefined;
    if (fieldInfo && isConnectionFieldInfo(fieldInfo)) {
      const { edgeTypeInfo } = fieldInfo;
      const { nodeType } = edgeTypeInfo;
      if (
        (fieldInfo.nodeBackrefField && !updateDir) ||
        fieldInfo.nodeBackrefJoin ||
        !nodeType ||
        !this.isInputNodeType(nodeType)
      ) {
        return [];
      }
      namedType = getNamedType(nodeType);
      isList = true;
      wrapped.wrappers = [WrapperType.NON_NULL, WrapperType.LIST];
      edgeType = edgeTypeInfo.type;
      if (edgeTypeInfo.extraEdgeFields) {
        extraEdgeFields = edgeTypeInfo.extraEdgeFields.filter((f) => this.includeInCreate(f));
      }
    }

    if (updateDir) {
      const inputArg = getRequiredDirectiveArgument(updateDir, 'input', 'StringValue');
      const inputTypeName = (inputArg.value as StringValueNode).value;
      const foundType = this.schema.getType(inputTypeName);
      if (!foundType) {
        throw new Error(`Cannot find input type "${inputTypeName}" for field "${parentType.name}.${field.name}"`);
      }
      if (!isInputType(foundType)) {
        throw new Error(`Invalid input type "${inputTypeName}" for field "${parentType.name}.${field.name}"`);
      }
      addResult(foundType);
    } else if (isCompositeType(namedType)) {
      const typeInfo = this.analyzer.getTypeInfo(namedType);
      if (typeInfo.hasIdentity || !isObjectType(namedType)) {
        try {
          if (!isList) {
            return toConfigEntries(this.getIdRefFields(namedType, false, name));
          } else {
            const idRefs = this.getIdRefFields(namedType, false);

            // create ref/edge input object only if multiple IDs or extra edge fields
            if (idRefs.length > 1 || extraEdgeFields?.length) {
              addResult(this.makeIdRefType(namedType, idRefs, edgeType, extraEdgeFields));
            }

            // if only one ID and no required edge fields, emit a shorthand ID-list field
            if (idRefs.length === 1 && (!extraEdgeFields || !this.containsRequiredFields(extraEdgeFields))) {
              // connection field "theFoos" with node ID field "barId" becomes "theFooBarIds"
              const idsName = joinCamelCase(
                mapLast(splitCamelCase(name), singular).concat(mapLast(splitCamelCase(idRefs[0].name), plural))
              );
              addResult(idRefs[0].type, idRefs[0].directive, idsName);
            }
          }
        } catch (e) {
          throw new Error(`${e.message} for field "${parentType.name}.${field.name}"`);
        }
      } else {
        const nestedType = this.makeUpdateType(namedType, `Nested${namedType.name}`);
        if (nestedType) {
          addResult(nestedType);
        }
      }
    } else {
      addResult(namedType, findFirstDirective(field, this.config.wkidDirective));
    }

    return result;
  }

  private isInputNodeType(type: GraphQLNullableType): boolean {
    // allows lists of input types but not (nested) lists of object IDs
    if (isInputType(type)) return true;
    const typeInfo = this.analyzer.getTypeInfo(type);
    return typeInfo.externalIdField != null;
  }

  private containsRequiredFields(fields: FieldType[]): boolean {
    return fields.some((f) => isNonNullType(f.type) && !this.hasDefault(f));
  }

  private makeIdRefType(
    type: GraphQLCompositeType,
    idRefs: FieldDesc[],
    edgeType?: GraphQLObjectType,
    extraEdgeFields?: FieldType[]
  ): GraphQLInputType {
    let baseName: string;
    let name: string;
    if (edgeType && extraEdgeFields?.length) {
      baseName = edgeType.name;
      name = `Create${baseName}Input`;
    } else {
      name = baseName = `${type.name}Ref`;
    }
    let result = this.nestedTypes.get(name);
    if (!result) {
      let description;
      const fields = toConfigEntries(idRefs.map((r) => ({ ...r, type: new GraphQLNonNull(r.type) })));
      if (edgeType && extraEdgeFields?.length) {
        description = `Automatically generated input type for ${edgeType.name}`;
        fields.push(...extraEdgeFields.flatMap((f) => this.getCreateInputFields(f, edgeType, baseName)));
      } else {
        description = `Automatically generated input type for reference to ${type.name}`;
      }
      result = makeInputObjectType(name, description, fields);
      this.nestedTypes.set(name, result);
    }
    return result;
  }

  private getIdRefFields(type: GraphQLCompositeType, nonNull: boolean, namePrefix?: string): FieldDesc[] {
    const typeInfo = this.analyzer.getTypeInfo(type);
    const { externalIdField } = typeInfo;
    if (externalIdField) {
      let name = externalIdField.name;
      if (namePrefix && !name.startsWith(namePrefix)) {
        name = namePrefix + ucFirst(name);
      }
      let fieldType: GraphQLInputType = assertScalarType(getNullableType(externalIdField.type));
      if (nonNull) {
        fieldType = new GraphQLNonNull(fieldType);
      }
      return [
        { name, type: fieldType, directive: this.getExternalIdRefDirective(typeInfo.externalIdDirective!, type.name)! },
      ];
    }

    const { internalIdFields } = typeInfo;
    if (internalIdFields) {
      return internalIdFields.flatMap((field) => this.getIdRefFieldsFor(field, type, nonNull, namePrefix));
    }

    // see if all object types of an interface or union have a common external ID type
    if (isInterfaceType(type) || isUnionType(type)) {
      const objectTypes = isInterfaceType(type) ? this.analyzer.getImplementingTypes(type) : type.getTypes();
      try {
        const dir = this.getExternalIdDirective(objectTypes);
        if (dir) {
          const name = namePrefix ? namePrefix + 'Id' : 'id';
          let fieldType: GraphQLInputType = this.getExternalIdType(objectTypes);
          if (nonNull) {
            fieldType = new GraphQLNonNull(fieldType);
          }
          return [{ name, type: fieldType, directive: this.getExternalIdRefDirective(dir, type.name) }];
        }
      } catch (e) {
        throw new Error(`Unable to reference type "${type.name}": ${e.message}`);
      }
    }

    throw new Error(`No ID fields for referenced type "${type.name}"`);
  }

  private getIdRefFieldsFor(
    field: FieldType,
    type: GraphQLCompositeType,
    nonNull: boolean,
    namePrefix?: string
  ): FieldDesc[] {
    let name = field.name;
    if (namePrefix && !name.startsWith(namePrefix)) {
      name = namePrefix + ucFirst(name);
    }
    let fieldType = getNullableType(field.type);
    if (isScalarType(fieldType) || isEnumType(fieldType)) {
      if (nonNull) {
        fieldType = new GraphQLNonNull(fieldType);
      }
      return [{ name, type: fieldType, directive: this.getIdRefDirective(type.name, field.name) }];
    }
    if (isCompositeType(fieldType)) {
      return this.getIdRefFields(fieldType, nonNull, name);
    }
    throw new Error(`Unexpected type for ID field ${type.name}.${field.name}`);
  }

  private getIdRefDirective(type: string, field?: string): DirectiveNode {
    const args: ArgumentNode[] = [makeStringArgumentNode('type', type)];
    if (field) {
      args.push(makeStringArgumentNode('field', field));
    }
    return makeDirectiveNode(this.config.idRefDirective, args);
  }

  private getExternalIdRefDirective(originalDirective: DirectiveNode, type: string): DirectiveNode {
    let name;
    const args: ArgumentNode[] = [];
    switch (originalDirective.name.value) {
      case this.config.randomIdDirective:
        name = this.config.randomIdRefDirective;
        break;
      case this.config.wkidDirective:
        name = this.config.wkidRefDirective;
        if (originalDirective.arguments) {
          args.push(...originalDirective.arguments);
        }
        break;
      default:
        throw new Error();
    }
    args.push(makeStringArgumentNode('type', type));
    return makeDirectiveNode(name, args);
  }

  private getExternalIdDirective(objectTypes: Iterable<GraphQLObjectType>): DirectiveNode | undefined {
    return Array.from(objectTypes, (impl) => {
      const typeInfo = this.analyzer.findTypeInfo(impl);
      if (!typeInfo || !typeInfo.externalIdDirective) {
        throw new Error(`No external ID for type "${impl.name}"`);
      }
      return typeInfo.externalIdDirective;
    }).reduce<DirectiveNode | undefined>((result, dir) => {
      if (!result) {
        return dir;
      } else if (result.name.value !== dir.name.value) {
        throw new Error(`Found conflicting external ID directives: "${result.name.value}" and "${dir.name.value}"`);
      }
      return result;
    }, undefined);
  }

  private getExternalIdType(objectTypes: Iterable<GraphQLObjectType>): GraphQLScalarType {
    const resultType = Array.from(objectTypes, (impl) => {
      const typeInfo = this.analyzer.findTypeInfo(impl);
      if (!typeInfo || !typeInfo.externalIdField) {
        throw new Error(`No external ID for type "${impl.name}"`);
      }
      return typeInfo.externalIdField;
    }).reduce<GraphQLScalarType | undefined>((type, field) => {
      const fieldType = assertScalarType(getNullableType(field.type));
      if (!type) {
        return fieldType;
      } else if (type !== fieldType) {
        throw new Error(`Found conflicting external ID types: "${type.name}" and "${fieldType.name}"`);
      }
      return type;
    }, undefined);
    if (!resultType) {
      throw new Error('No implementations for interface');
    }
    return resultType;
  }

  private getDeleteType(type: GraphQLObjectType): GraphQLInputObjectType | null {
    let deleteType = this.deleteTypes.get(type);
    if (deleteType === undefined) {
      deleteType = this.makeDeleteType(type);
      this.deleteTypes.set(type, deleteType);
    }
    return deleteType;
  }

  private makeDeleteType(type: GraphQLObjectType): GraphQLInputObjectType | null {
    const name = `Delete${type.name}Input`;
    const existingType = this.schema.getType(name);
    if (existingType) {
      if (!isInputObjectType(existingType)) {
        throw new Error(`Generated input type ${name} conflicts with existing type`);
      }
      return existingType;
    }

    const fields: [string, GraphQLInputFieldConfig][] = [
      makeInputFieldConfigEntry(CLIENT_MUTATION_ID, GraphQLString),
      ...toConfigEntries(this.getIdRefFields(type, true)),
    ];
    const description = `Automatically generated input type for ${this.mutationTypeName}.delete${type.name}`;
    return new GraphQLInputObjectType({
      name,
      description,
      fields: Object.fromEntries(fields),
      astNode: {
        kind: 'InputObjectTypeDefinition',
        name: makeNameNode(name),
        description: {
          kind: 'StringValue',
          value: description,
          block: true,
        },
        fields: fields.map((f) => f[1].astNode!),
      },
    });
  }

  @Memoize()
  private getReadonlyDirectives(): Set<string> {
    return new Set([
      this.config.autoincDirective,
      this.config.createdAtDirective,
      this.config.randomIdDirective,
      this.config.readonlyDirective,
      this.config.softDeleteDirective,
      this.config.typeDiscriminatorDirective,
      this.config.updatedAtDirective,
    ]);
  }

  private includeInCreate(field: FieldType): boolean {
    if (hasDirectives(field, this.getNoCreateDirectives())) return false;
    const derived = findFirstDirective(field, this.config.derivedDirective);
    return !derived || hasDirectiveFlag(derived, 'writable');
  }

  @Memoize()
  private getNoCreateDirectives(): Set<string> {
    return new Set(Array.from(this.getReadonlyDirectives()).concat(this.config.updateOnlyDirective));
  }

  private includeInUpdate(field: FieldType): boolean {
    if (hasDirectives(field, this.getNoUpdateDirectives())) return false;
    const derived = findFirstDirective(field, this.config.derivedDirective);
    return !derived || hasDirectiveFlag(derived, 'writable');
  }

  @Memoize()
  private getNoUpdateDirectives(): Set<string> {
    return new Set(
      Array.from(this.getReadonlyDirectives()).concat(
        this.config.immutableDirective,
        this.config.idDirective,
        this.config.wkidDirective
      )
    );
  }

  private hasDefault(field: FieldType): boolean {
    return hasDirectives(field, this.getDefaultDirectives());
  }

  @Memoize()
  private getDefaultDirectives(): Set<string> {
    return new Set([this.config.defaultDirective, this.config.generatedDefaultDirective]);
  }
}

function makeInputObjectType(
  name: string,
  description: string,
  fields: [string, GraphQLInputFieldConfig][]
): GraphQLInputObjectType {
  return new GraphQLInputObjectType({
    name,
    description,
    fields: Object.fromEntries(fields),
    astNode: {
      kind: 'InputObjectTypeDefinition',
      name: makeNameNode(name),
      description: {
        kind: 'StringValue',
        value: description,
        block: true,
      },
      fields: fields.map((f) => f[1].astNode!),
    },
  });
}

function toConfigEntries(f: FieldDesc[]): [string, GraphQLInputFieldConfig][] {
  return f.map(toConfigEntry);
}

function toConfigEntry(f: FieldDesc): [string, GraphQLInputFieldConfig] {
  return makeInputFieldConfigEntry(f.name, f.type, f.directive && [f.directive]);
}

function makeInputFieldConfigEntry(
  name: string,
  type: GraphQLInputType,
  directives?: DirectiveNode[]
): [string, GraphQLInputFieldConfig] {
  return [name, { type: type, astNode: makeInputValueDefinitionNode(name, type, directives) }];
}

function makeInputValueDefinitionNode(
  name: string,
  type: GraphQLInputType,
  directives?: DirectiveNode[]
): InputValueDefinitionNode {
  return {
    kind: 'InputValueDefinition',
    name: makeNameNode(name),
    type: makeTypeNode(type),
    directives,
  };
}

function makeTypeNode(type: GraphQLNamedType): NamedTypeNode;
function makeTypeNode(type: GraphQLList<GraphQLType>): ListTypeNode;
function makeTypeNode(type: GraphQLNonNull<GraphQLNullableType>): NonNullTypeNode;
function makeTypeNode(type: GraphQLType): TypeNode;
function makeTypeNode(type: GraphQLType): TypeNode {
  if (isNonNullType(type)) {
    return {
      kind: 'NonNullType',
      type: makeTypeNode(type.ofType),
    };
  }
  if (isListType(type)) {
    return {
      kind: 'ListType',
      type: makeTypeNode(type.ofType),
    };
  }
  return {
    kind: 'NamedType',
    name: makeNameNode(type.name),
  };
}

function makeDirectiveNode(name: string, args?: ArgumentNode[]): DirectiveNode {
  return {
    kind: 'Directive',
    name: makeNameNode(name),
    arguments: args,
  };
}

function makeStringArgumentNode(name: string, value: string): ArgumentNode {
  return {
    kind: 'Argument',
    name: makeNameNode(name),
    value: {
      kind: 'StringValue',
      value: value,
    },
  };
}

function makeNameNode(name: string): NameNode {
  return {
    kind: 'Name',
    value: name,
  };
}
