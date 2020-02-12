import fs from 'fs';
import {
  ArgumentNode,
  assertScalarType,
  buildASTSchema,
  DirectiveNode,
  getNullableType,
  GraphQLBoolean,
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
  isInputObjectType,
  isInputType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  ListTypeNode,
  NamedTypeNode,
  NameNode,
  NonNullTypeNode,
  parse,
  StringValueNode,
  TypeNode
} from 'graphql';
import path from 'path';
import { Memoize } from 'typescript-memoize';
import { Analyzer, TypeInfo } from './Analyzer';
import { DirectiveConfig } from './config/DirectiveConfig';
import { findFirstDirective, getDirectiveArgument, hasDirectives } from './util/ast-util';
import { lcFirst, ucFirst } from './util/case';
import { compare } from './util/compare';
import { unwrapType, wrapType } from './util/graphql-util';

type FieldType = GraphQLField<any, any>;

export const CLIENT_MUTATION_ID = 'clientMutationId';
export const DELETED_FLAG = 'deleted';
const DEFAULT_MUTATION_TYPE_NAME = 'Mutation';

export class MutationBuilder {
  private readonly config: DirectiveConfig;
  private readonly mutationTypeName: string;
  private readonly createTypes: Map<GraphQLObjectType, GraphQLInputObjectType | null> = new Map();
  private readonly updateTypes: Map<GraphQLObjectType, GraphQLInputObjectType | null> = new Map();
  private readonly deleteTypes: Map<GraphQLObjectType, GraphQLInputObjectType | null> = new Map();

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
      schemaConfig.types = schemaConfig.types.filter(type => type !== mutation);
    } else {
      mutationConfig = {
        name: DEFAULT_MUTATION_TYPE_NAME,
        description: 'Automatically generated mutations',
        fields: {}
      };
    }
    const crudMutations = this.generateMutations(Object.keys(mutationConfig.fields));
    mutationConfig.fields = Object.fromEntries(Object.entries(mutationConfig.fields).concat(crudMutations));
    schemaConfig.mutation = new GraphQLObjectType(mutationConfig);

    // ensure resulting schema includes input directives not used by original schema
    const directivesSource = fs.readFileSync(path.join(path.dirname(__dirname), 'sdl', 'directives.graphql'), {
      encoding: 'utf8'
    });
    const directivesAst = parse(directivesSource);
    const directivesSchema = buildASTSchema(directivesAst);
    const existingDirectiveNames = new Set(schemaConfig.directives.map(d => d.name));
    schemaConfig.directives = schemaConfig.directives.concat(
      directivesSchema.getDirectives().filter(d => !existingDirectiveNames.has(d.name))
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
          const createType = this.getCreateType(type, false);
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
                      [lcFirst(type.name)]: { type: new GraphQLNonNull(type) }
                    }
                  })
                ),
                args: { input: { type: new GraphQLNonNull(createType) } }
              }
            ]);
          }
        }
        // TODO: @update
        const updateName = `update${type.name}`;
        if (!existingSet.has(updateName)) {
          const updateType = this.getUpdateType(type, false);
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
                      [lcFirst(type.name)]: { type: new GraphQLNonNull(type) }
                    }
                  })
                ),
                args: { input: { type: new GraphQLNonNull(updateType) } }
              }
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
                      [DELETED_FLAG]: { type: new GraphQLNonNull(GraphQLBoolean) }
                    }
                  })
                ),
                args: { input: { type: new GraphQLNonNull(deleteType) } }
              }
            ]);
          }
        }
      }
    }
    return fields.sort((a, b) => compare(a[0], b[0]));
  }

  private isConcreteEntityTable(typeInfo: TypeInfo): typeInfo is TypeInfo<GraphQLObjectType> {
    return (
      isObjectType(typeInfo.type) && // not an interface table
      typeInfo.hasIdentity && // not a nested/1:1 table
      (!typeInfo.internalIdFields || typeInfo.internalIdFields.length <= 1) // not a join table
    );
  }

  private getCreateType(type: GraphQLObjectType, nested: boolean): GraphQLInputObjectType | null {
    let createType = this.createTypes.get(type);
    if (createType === undefined) {
      const name = `Create${type.name}Input`;
      const existingType = this.schema.getType(name);
      if (existingType) {
        if (isInputObjectType(existingType)) {
          createType = existingType;
        } else {
          throw new Error(`Generated input type ${name} conflicts with existing type`);
        }
      } else {
        const fields = Object.values(type.getFields())
          .map(f => this.getCreateInputField(f, type.name))
          .filter(notNull);
        if (fields.length > 0) {
          if (!nested) {
            fields.unshift([
              CLIENT_MUTATION_ID,
              { type: GraphQLString, astNode: makeInputValueDefinitionNode(CLIENT_MUTATION_ID, GraphQLString) }
            ]);
          }
          const description = `Automatically generated input type for ${this.mutationTypeName}.create${type.name}`;
          createType = new GraphQLInputObjectType({
            name,
            description,
            fields: Object.fromEntries(fields),
            astNode: {
              kind: 'InputObjectTypeDefinition',
              name: makeNameNode(name),
              description: {
                kind: 'StringValue',
                value: description,
                block: true
              },
              fields: fields.map(f => f[1].astNode!)
            }
          });
        } else {
          createType = null;
        }
      }
      this.createTypes.set(type, createType);
    }
    return createType;
  }

  private getCreateInputField(field: FieldType, typeName: string): [string, GraphQLInputFieldConfig] | null {
    if (hasDirectives(field, this.getReadonlyDirectives())) {
      return null;
    }

    let { name, type } = field;
    let nonNull = false;
    if (isNonNullType(type)) {
      type = type.ofType;
      nonNull = !hasDirectives(field, this.getDefaultDirectives());
    }
    const wrapped = unwrapType(type);
    const fieldType = wrapped.type;

    if (this.analyzer.isConnectionType(type)) {
      // TODO: revisit?
      return null;
    }

    let inputType;
    let inputDir;
    const createDir = findFirstDirective(field, this.config.createNestedDirective);
    if (createDir) {
      const inputArg = getDirectiveArgument(createDir, 'input');
      if (inputArg) {
        const inputTypeName = (inputArg.value as StringValueNode).value;
        inputType = this.schema.getType(inputTypeName);
        if (!inputType) {
          throw new Error(`Cannot find input type "${inputTypeName}" for field "${field.name}"`);
        }
        if (!isInputType(inputType)) {
          throw new Error(`Invalid input type "${inputTypeName}" for field "${field.name}"`);
        }
      } else {
        const thisArg = getDirectiveArgument(createDir, 'this');
        if (thisArg) {
          const thisFieldName = (thisArg.value as StringValueNode).value;
          if (!isObjectType(fieldType)) {
            throw new Error(
              `Object type required for field "${field.name}" with @${this.config.createNestedDirective}.this`
            );
          }
          const nestedTypeName = typeName + ucFirst(field.name);
          const fields = Object.values(fieldType.getFields())
            .filter(f => f.name !== thisFieldName)
            .map(f => this.getCreateInputField(f, nestedTypeName))
            .filter(notNull);
          if (!fields.length) {
            throw new Error(
              `No nested fields found for field "${field.name}" with @${this.config.createNestedDirective}.this`
            );
          }
          inputType = new GraphQLInputObjectType({
            name: `Create${nestedTypeName}Input`,
            fields: Object.fromEntries(fields)
          });
        }
      }
    }
    if (!inputType) {
      if (isCompositeType(fieldType)) {
        const typeInfo = this.analyzer.findTypeInfo(fieldType);
        if (typeInfo && typeInfo.externalIdField) {
          inputType = assertScalarType(getNullableType(typeInfo.externalIdField.type));
          inputDir = this.getExternalIdRefDirective(typeInfo.externalIdDirective!, fieldType.name);
          name += 'Id';
        } else if (isObjectType(fieldType)) {
          inputType = this.getCreateType(fieldType, true);
          if (!inputType) {
            return null;
          }
        } else {
          const objectTypes = isInterfaceType(fieldType)
            ? this.analyzer.getImplementingTypes(fieldType)
            : fieldType.getTypes();
          try {
            inputType = this.getExternalIdType(objectTypes);
            inputDir = this.getExternalIdRefDirective(this.getExternalIdDirective(objectTypes)!, fieldType.name);
            name += 'Id';
          } catch (e) {
            throw new Error(
              `Cannot convert type "${fieldType.name}" to input type for field "${field.name}": ${e.message}`
            );
          }
        }
      } else {
        inputType = fieldType;
        inputDir = findFirstDirective(field, this.config.stringIdDirective);
      }
    }

    inputType = wrapType(inputType, wrapped.wrappers) as GraphQLInputType;
    if (nonNull) {
      inputType = new GraphQLNonNull(inputType);
    }
    const astNode = makeInputValueDefinitionNode(name, inputType, inputDir && [inputDir]);
    return [name, { type: inputType, astNode }];
  }

  private getUpdateType(type: GraphQLObjectType, nested: boolean): GraphQLInputObjectType | null {
    let updateType = this.updateTypes.get(type);
    if (updateType === undefined) {
      const name = `Update${type.name}Input`;
      const existingType = this.schema.getType(name);
      if (existingType) {
        if (isInputObjectType(existingType)) {
          updateType = existingType;
        } else {
          throw new Error(`Generated input type ${name} conflicts with existing type`);
        }
      } else {
        const typeInfo = this.analyzer.findTypeInfo(type);
        const externalIdField = typeInfo ? typeInfo.externalIdField : null;
        const fields = Object.values(type.getFields())
          .map(f => this.getUpdateInputField(f))
          .filter(notNull);
        if (fields.length > 0 && (externalIdField || nested)) {
          if (externalIdField) {
            const externalIdType = new GraphQLNonNull(assertScalarType(getNullableType(externalIdField.type)));
            fields.unshift([
              externalIdField.name,
              {
                type: externalIdType,
                astNode: makeInputValueDefinitionNode(externalIdField.name, externalIdType, [
                  this.getExternalIdRefDirective(typeInfo?.externalIdDirective!, type.name)!
                ])
              }
            ]);
          }
          if (!nested) {
            fields.unshift([
              CLIENT_MUTATION_ID,
              { type: GraphQLString, astNode: makeInputValueDefinitionNode(CLIENT_MUTATION_ID, GraphQLString) }
            ]);
          }
          const description = `Automatically generated input type for ${this.mutationTypeName}.update${type.name}`;
          updateType = new GraphQLInputObjectType({
            name,
            description,
            fields: Object.fromEntries(fields),
            astNode: {
              kind: 'InputObjectTypeDefinition',
              name: makeNameNode(name),
              description: {
                kind: 'StringValue',
                value: description,
                block: true
              },
              fields: fields.map(f => f[1].astNode!)
            }
          });
        } else {
          updateType = null;
        }
      }
      this.updateTypes.set(type, updateType);
    }
    return updateType;
  }

  private getUpdateInputField(field: FieldType): [string, GraphQLInputFieldConfig] | null {
    if (hasDirectives(field, this.getImmutableDirectives())) {
      return null;
    }

    let { name, type } = field;
    if (isNonNullType(type)) {
      type = type.ofType;
    }
    const wrapped = unwrapType(type);
    const fieldType = wrapped.type;

    if (this.analyzer.isConnectionType(fieldType)) {
      // TODO: revisit?
      return null;
    }

    let inputType;
    let externalIdDir;
    const updateDir = findFirstDirective(field, this.config.updateNestedDirective);
    if (updateDir) {
      const inputArg = getDirectiveArgument(updateDir, 'input');
      if (inputArg) {
        const inputTypeName = (inputArg.value as StringValueNode).value;
        inputType = this.schema.getType(inputTypeName);
        if (!inputType) {
          throw new Error(`Cannot find input type "${inputTypeName}" for field "${field.name}"`);
        }
        if (!isInputType(inputType)) {
          throw new Error(`Invalid input type "${inputTypeName}" for field "${field.name}"`);
        }
      }
    }
    if (!inputType) {
      if (isCompositeType(fieldType)) {
        const typeInfo = this.analyzer.findTypeInfo(fieldType);
        if (typeInfo && typeInfo.externalIdField) {
          inputType = assertScalarType(getNullableType(typeInfo.externalIdField.type));
          externalIdDir = typeInfo.externalIdDirective;
          name += 'Id';
        } else if (isObjectType(fieldType)) {
          inputType = this.getUpdateType(fieldType, true);
          if (!inputType) {
            return null;
          }
        } else {
          const objectTypes = isInterfaceType(fieldType)
            ? this.analyzer.getImplementingTypes(fieldType)
            : fieldType.getTypes();
          try {
            inputType = this.getExternalIdType(objectTypes);
            externalIdDir = this.getExternalIdDirective(objectTypes);
            name += 'Id';
          } catch (e) {
            throw new Error(
              `Cannot convert type "${fieldType.name}" to input type for field "${field.name}": ${e.message}`
            );
          }
        }
      } else {
        inputType = fieldType;
      }
    }

    inputType = wrapType(inputType, wrapped.wrappers) as GraphQLInputType;
    const refDir = externalIdDir && this.getExternalIdRefDirective(externalIdDir, fieldType.name);
    const astNode = makeInputValueDefinitionNode(name, inputType, refDir && [refDir]);
    return [name, { type: inputType, astNode }];
  }

  private getExternalIdRefDirective(originalDirective: DirectiveNode, type: string): DirectiveNode | undefined {
    let name;
    const args: ArgumentNode[] = [];
    switch (originalDirective.name.value) {
      case this.config.randomIdDirective:
        name = this.config.randomIdRefDirective;
        break;
      case this.config.stringIdDirective:
        name = this.config.stringIdRefDirective;
        if (originalDirective.arguments) {
          args.push(...originalDirective.arguments);
        }
        break;
      default:
        return undefined;
    }
    args.push({
      kind: 'Argument',
      name: makeNameNode('type'),
      value: {
        kind: 'StringValue',
        value: type
      }
    });
    return {
      kind: 'Directive',
      name: makeNameNode(name),
      arguments: args
    };
  }

  private getExternalIdDirective(objectTypes: Iterable<GraphQLObjectType>): DirectiveNode | undefined {
    return Array.from(objectTypes, impl => {
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
    const resultType = Array.from(objectTypes, impl => {
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
      const name = `Delete${type.name}Input`;
      const existingType = this.schema.getType(name);
      if (existingType) {
        if (isInputObjectType(existingType)) {
          deleteType = existingType;
        } else {
          throw new Error(`Generated input type ${name} conflicts with existing type`);
        }
      } else {
        const typeInfo = this.analyzer.findTypeInfo(type);
        if (typeInfo && typeInfo.externalIdField) {
          const { externalIdField } = typeInfo;
          const externalIdType = new GraphQLNonNull(assertScalarType(getNullableType(externalIdField.type)));
          const fields: [string, GraphQLInputFieldConfig][] = [
            [
              CLIENT_MUTATION_ID,
              { type: GraphQLString, astNode: makeInputValueDefinitionNode(CLIENT_MUTATION_ID, GraphQLString) }
            ],
            [
              externalIdField.name,
              {
                type: externalIdType,
                astNode: makeInputValueDefinitionNode(externalIdField.name, externalIdType, [
                  this.getExternalIdRefDirective(typeInfo.externalIdDirective!, type.name)!
                ])
              }
            ]
          ];
          const description = `Automatically generated input type for ${this.mutationTypeName}.delete${type.name}`;
          deleteType = new GraphQLInputObjectType({
            name,
            description,
            fields: Object.fromEntries(fields),
            astNode: {
              kind: 'InputObjectTypeDefinition',
              name: makeNameNode(name),
              description: {
                kind: 'StringValue',
                value: description,
                block: true
              },
              fields: fields.map(f => f[1].astNode!)
            }
          });
        } else {
          deleteType = null;
        }
      }
      this.deleteTypes.set(type, deleteType);
    }
    return deleteType;
  }

  @Memoize()
  private getReadonlyDirectives(): Set<string> {
    return new Set([
      this.config.createdAtDirective,
      this.config.derivedDirective,
      this.config.internalIdDirective,
      this.config.randomIdDirective,
      this.config.readonlyDirective,
      this.config.softDeleteDirective,
      this.config.typeDiscriminatorDirective,
      this.config.updatedAtDirective
    ]);
  }

  @Memoize()
  private getImmutableDirectives(): Set<string> {
    return new Set(
      Array.from(this.getReadonlyDirectives()).concat(this.config.immutableDirective, this.config.stringIdDirective)
    );
  }

  @Memoize()
  private getDefaultDirectives(): Set<string> {
    return new Set([this.config.defaultDirective, this.config.generatedDefaultDirective]);
  }
}

function notNull<T>(t: T | null): t is T {
  return t != null;
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
    directives
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
      type: makeTypeNode(type.ofType)
    };
  }
  if (isListType(type)) {
    return {
      kind: 'ListType',
      type: makeTypeNode(type.ofType)
    };
  }
  return {
    kind: 'NamedType',
    name: makeNameNode(type.name)
  };
}

function makeNameNode(name: string): NameNode {
  return {
    kind: 'Name',
    value: name
  };
}
