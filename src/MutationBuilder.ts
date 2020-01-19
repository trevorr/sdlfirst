import {
  assertScalarType,
  getNullableType,
  GraphQLBoolean,
  GraphQLField,
  GraphQLFieldConfig,
  GraphQLInputFieldConfig,
  GraphQLInputObjectType,
  GraphQLInputType,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLObjectTypeConfig,
  GraphQLOutputType,
  GraphQLScalarType,
  GraphQLSchema,
  GraphQLString,
  isEnumType,
  isInputType,
  isInterfaceType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isUnionType,
  StringValueNode
} from 'graphql';
import { Memoize } from 'typescript-memoize';
import { Analyzer, TypeInfo } from './Analyzer';
import { DirectiveConfig } from './config/DirectiveConfig';
import { findFirstDirective, getDirectiveArgument, hasDirectives } from './util/ast-util';
import { compare } from './util/compare';
import { unwrapType, wrapType } from './util/graphql-util';

type FieldType = GraphQLField<any, any>;

const CLIENT_MUTATION_ID = 'clientMutationId';
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
    const crudMutations = this.generateMutations();
    mutationConfig.fields = Object.fromEntries(Object.entries(mutationConfig.fields).concat(crudMutations));
    schemaConfig.mutation = new GraphQLObjectType(mutationConfig);
    return new GraphQLSchema(schemaConfig);
  }

  public generateMutations(): [string, GraphQLFieldConfig<any, any>][] {
    const fields: [string, GraphQLFieldConfig<any, any>][] = [];
    for (const typeInfo of this.analyzer.getTypeInfos()) {
      if (this.isConcreteEntityTable(typeInfo)) {
        const { type } = typeInfo;
        // TODO: @create
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
        // TODO: @update
        const updateType = this.getUpdateType(type, false);
        if (updateType) {
          fields.push([
            `update${type.name}`,
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
        // TODO: @delete
        const deleteType = this.getDeleteType(type);
        if (deleteType) {
          fields.push([
            `delete${type.name}`,
            {
              type: new GraphQLNonNull(
                new GraphQLObjectType({
                  name: `Delete${type.name}Payload`,
                  description: `Automatically generated output type for ${this.mutationTypeName}.delete${type.name}`,
                  fields: {
                    [CLIENT_MUTATION_ID]: { type: GraphQLString },
                    deleted: { type: new GraphQLNonNull(GraphQLBoolean) }
                  }
                })
              ),
              args: { input: { type: new GraphQLNonNull(deleteType) } }
            }
          ]);
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
      const fields = Object.values(type.getFields())
        .map(f => this.getCreateInputField(f, type.name))
        .filter(notNull);
      if (fields.length > 0) {
        if (!nested) {
          fields.unshift([CLIENT_MUTATION_ID, { type: GraphQLString }]);
        }
        createType = new GraphQLInputObjectType({
          name: `Create${type.name}Input`,
          description: `Automatically generated input type for ${this.mutationTypeName}.create${type.name}`,
          fields: Object.fromEntries(fields)
        });
      } else {
        createType = null;
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
    type = wrapped.type as GraphQLOutputType;

    if (this.analyzer.isConnectionType(type)) {
      // TODO: revisit?
      return null;
    }

    let inputType;
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
          if (!isObjectType(type)) {
            throw new Error(
              `Object type required for field "${field.name}" with @${this.config.createNestedDirective}.this`
            );
          }
          const nestedTypeName = typeName + ucFirst(field.name);
          const fields = Object.values(type.getFields())
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
      if (isScalarType(type) || isEnumType(type)) {
        inputType = type;
      } else if (isObjectType(type)) {
        const typeInfo = this.analyzer.findTypeInfo(type);
        if (typeInfo && typeInfo.externalIdField) {
          inputType = assertScalarType(getNullableType(typeInfo.externalIdField.type));
          name += 'Id';
        } else {
          inputType = this.getCreateType(type, true);
          if (!inputType) {
            return null;
          }
        }
      } else if (isInterfaceType(type)) {
        const typeInfo = this.analyzer.findTypeInfo(type);
        if (typeInfo && typeInfo.externalIdField) {
          inputType = assertScalarType(getNullableType(typeInfo.externalIdField.type));
        } else {
          try {
            inputType = this.getExternalIdType(this.analyzer.getImplementingTypes(type));
          } catch (e) {
            throw new Error(
              `Cannot convert interface type "${type.name}" to input type for field "${field.name}": ${e.message}`
            );
          }
        }
        name += 'Id';
      } else if (isUnionType(type)) {
        try {
          inputType = this.getExternalIdType(type.getTypes());
        } catch (e) {
          throw new Error(
            `Cannot convert union type "${type.name}" to input type for field "${field.name}": ${e.message}`
          );
        }
        name += 'Id';
      } else {
        inputType = type;
      }
    }

    inputType = wrapType(inputType, wrapped.wrappers) as GraphQLInputType;
    if (nonNull) {
      inputType = new GraphQLNonNull(inputType);
    }
    return [name, { type: inputType }];
  }

  private getUpdateType(type: GraphQLObjectType, nested: boolean): GraphQLInputObjectType | null {
    let updateType = this.updateTypes.get(type);
    if (updateType === undefined) {
      const typeInfo = this.analyzer.findTypeInfo(type);
      const externalIdField = typeInfo ? typeInfo.externalIdField : null;
      const fields = Object.values(type.getFields())
        .map(f => this.getUpdateInputField(f))
        .filter(notNull);
      if (fields.length > 0 && (externalIdField || nested)) {
        if (externalIdField) {
          fields.unshift([
            externalIdField.name,
            {
              type: new GraphQLNonNull(assertScalarType(getNullableType(externalIdField.type)))
            }
          ]);
        }
        if (!nested) {
          fields.unshift([CLIENT_MUTATION_ID, { type: GraphQLString }]);
        }
        updateType = new GraphQLInputObjectType({
          name: `Update${type.name}Input`,
          description: `Automatically generated input type for ${this.mutationTypeName}.update${type.name}`,
          fields: Object.fromEntries(fields)
        });
      } else {
        updateType = null;
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
    type = wrapped.type as GraphQLOutputType;

    if (this.analyzer.isConnectionType(type)) {
      // TODO: revisit?
      return null;
    }

    let inputType;
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
      if (isScalarType(type) || isEnumType(type)) {
        inputType = type;
      } else if (isObjectType(type)) {
        const typeInfo = this.analyzer.findTypeInfo(type);
        if (typeInfo && typeInfo.externalIdField) {
          inputType = assertScalarType(getNullableType(typeInfo.externalIdField.type));
          name += 'Id';
        } else {
          inputType = this.getUpdateType(type, true);
          if (!inputType) {
            return null;
          }
        }
      } else if (isInterfaceType(type)) {
        const typeInfo = this.analyzer.findTypeInfo(type);
        if (typeInfo && typeInfo.externalIdField) {
          inputType = assertScalarType(getNullableType(typeInfo.externalIdField.type));
        } else {
          try {
            inputType = this.getExternalIdType(this.analyzer.getImplementingTypes(type));
          } catch (e) {
            throw new Error(
              `Cannot convert interface type "${type.name}" to input type for field "${field.name}": ${e.message}`
            );
          }
        }
        name += 'Id';
      } else if (isUnionType(type)) {
        try {
          inputType = this.getExternalIdType(type.getTypes());
        } catch (e) {
          throw new Error(
            `Cannot convert union type "${type.name}" to input type for field "${field.name}": ${e.message}`
          );
        }
        name += 'Id';
      } else {
        inputType = type;
      }
    }

    inputType = wrapType(inputType, wrapped.wrappers) as GraphQLInputType;
    return [name, { type: inputType }];
  }

  private getExternalIdType(objectTypes: Iterable<GraphQLObjectType>): GraphQLScalarType {
    let resultType;
    for (const impl of objectTypes) {
      const typeInfo = this.analyzer.findTypeInfo(impl);
      if (!typeInfo || !typeInfo.externalIdField) {
        throw new Error(`No external ID for type "${impl.name}"`);
      }
      const externalIdType = assertScalarType(getNullableType(typeInfo.externalIdField.type));
      if (!resultType) {
        resultType = externalIdType;
      } else if (resultType !== externalIdType) {
        throw new Error(`Found multiple external ID types: "${resultType.name}" and "${externalIdType.name}"`);
      }
    }
    if (!resultType) {
      throw new Error('No implementations for interface');
    }
    return resultType;
  }

  private getDeleteType(type: GraphQLObjectType): GraphQLInputObjectType | null {
    let deleteType = this.deleteTypes.get(type);
    if (deleteType === undefined) {
      const typeInfo = this.analyzer.findTypeInfo(type);
      if (typeInfo && typeInfo.externalIdField) {
        deleteType = new GraphQLInputObjectType({
          name: `Delete${type.name}Input`,
          description: `Automatically generated input type for ${this.mutationTypeName}.delete${type.name}`,
          fields: {
            [CLIENT_MUTATION_ID]: {
              type: GraphQLString
            },
            [typeInfo.externalIdField.name]: {
              type: new GraphQLNonNull(assertScalarType(getNullableType(typeInfo.externalIdField.type)))
            }
          }
        });
      } else {
        deleteType = null;
      }
      this.deleteTypes.set(type, deleteType);
    }
    return deleteType;
  }

  @Memoize()
  private getReadonlyDirectives(): Set<string> {
    return new Set([
      this.config.createdAtDirective,
      this.config.externalIdDirective,
      this.config.internalIdDirective,
      this.config.readonlyDirective,
      this.config.typeDiscriminatorDirective,
      this.config.updatedAtDirective
    ]);
  }

  @Memoize()
  private getImmutableDirectives(): Set<string> {
    return new Set(Array.from(this.getReadonlyDirectives()).concat(this.config.immutableDirective));
  }

  @Memoize()
  private getDefaultDirectives(): Set<string> {
    return new Set([this.config.defaultDirective, this.config.generatedDefaultDirective]);
  }
}

function notNull<T>(t: T | null): t is T {
  return t != null;
}

function lcFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.substring(1);
}

function ucFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.substring(1);
}
