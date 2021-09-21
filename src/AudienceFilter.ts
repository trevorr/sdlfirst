import {
  EnumTypeDefinitionNode,
  FieldDefinitionNode,
  getNamedType,
  GraphQLDirective,
  GraphQLEnumType,
  GraphQLFieldConfig,
  GraphQLFieldConfigArgumentMap,
  GraphQLFieldConfigMap,
  GraphQLInputFieldConfigMap,
  GraphQLInputObjectType,
  GraphQLInterfaceType,
  GraphQLNamedType,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLUnionType,
  InputObjectTypeDefinitionNode,
  InterfaceTypeDefinitionNode,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isObjectType,
  isUnionType,
  ListValueNode,
  ObjectTypeDefinitionNode,
  StringValueNode,
  UnionTypeDefinitionNode,
  ValueNode,
} from 'graphql';
import { DirectiveConfig } from './config/DirectiveConfig';
import { findFirstDirective, getDirectiveArgument, WithDirectives } from './util/ast-util';
import { unwrapType, wrapType } from './util/graphql-util';

type TypeMap = Map<GraphQLNamedType, GraphQLNamedType>;

export class AudienceFilter {
  private readonly typeMap = new Map<GraphQLNamedType, GraphQLNamedType>();
  private readonly typeNames = new Set<string>();

  constructor(
    private readonly schema: GraphQLSchema,
    private readonly config: DirectiveConfig,
    private readonly audience: string
  ) {}

  public filterAudience(): GraphQLSchema {
    const config = this.schema.toConfig();

    for (const type of config.types) {
      if (!type.name.startsWith('__') && this.isIncluded(type)) {
        this.typeMap.set(type, this.filterNamedType(type));
        this.typeNames.add(type.name);
      }
    }

    const { query, mutation, subscription } = config;
    return new GraphQLSchema({
      ...config,
      query: query && mapType(query, this.typeMap),
      mutation: mutation && mapType(mutation, this.typeMap),
      subscription: subscription && mapType(subscription, this.typeMap),
      types: Array.from(this.typeMap.values()),
      directives: config.directives.map((d) => this.filterDirective(d)),
      astNode: undefined,
    });
  }

  private filterNamedType(type: GraphQLNamedType): GraphQLNamedType {
    if (isObjectType(type)) {
      return this.filterObjectType(type);
    } else if (isInterfaceType(type)) {
      return this.filterInterfaceType(type);
    } else if (isUnionType(type)) {
      return this.filterUnionType(type);
    } else if (isEnumType(type)) {
      return this.filterEnumType(type);
    } else if (isInputObjectType(type)) {
      return this.filterInputObjectType(type);
    }
    return type;
  }

  private filterObjectType(type: GraphQLObjectType): GraphQLObjectType {
    const config = type.toConfig();
    return new GraphQLObjectType({
      ...config,
      interfaces: () => mapTypes(config.interfaces, this.typeMap),
      fields: () => this.filterFieldConfigMap(config.fields),
      astNode: config.astNode && this.filterObjectTypeNode(config.astNode, type),
    });
  }

  private filterObjectTypeNode(astNode: ObjectTypeDefinitionNode, type: GraphQLObjectType): ObjectTypeDefinitionNode {
    return {
      ...astNode,
      interfaces: astNode.interfaces?.filter((t) => this.typeNames.has(t.name.value)),
      fields: astNode.fields?.filter((f) => {
        const field = type.getFields()[f.name.value];
        return field != null && this.isIncluded(field) && this.isIncluded(getNamedType(field.type));
      }),
    };
  }

  private filterInterfaceType(type: GraphQLInterfaceType): GraphQLInterfaceType {
    const config = type.toConfig();
    return new GraphQLInterfaceType({
      ...config,
      fields: () => this.filterFieldConfigMap(config.fields),
      astNode: config.astNode && this.filterInterfaceTypeNode(config.astNode, type),
    });
  }

  private filterInterfaceTypeNode(
    astNode: InterfaceTypeDefinitionNode,
    type: GraphQLInterfaceType
  ): InterfaceTypeDefinitionNode {
    return {
      ...astNode,
      fields: astNode.fields?.filter((f) => {
        const field = type.getFields()[f.name.value];
        return field != null && this.isIncluded(field) && this.isIncluded(getNamedType(field.type));
      }),
    };
  }

  private filterFieldConfigMap<TSource, TContext>(
    fields: GraphQLFieldConfigMap<TSource, TContext>
  ): GraphQLFieldConfigMap<TSource, TContext> {
    return Object.fromEntries(
      Object.entries(fields)
        .map(([key, field]) => {
          if (this.isIncluded(field)) {
            const { type, wrappers } = unwrapType(field.type);
            const newType = this.typeMap.get(type);
            if (newType) {
              const type = wrapType(newType, wrappers);
              return [
                key,
                {
                  ...field,
                  type,
                  args: field.args && this.filterFieldConfigArgumentMap(field.args),
                  astNode: field.astNode && this.filterFieldNode(field.astNode, field),
                },
              ];
            }
          }
        })
        .filter(notNull)
    );
  }

  private filterFieldNode(astNode: FieldDefinitionNode, field: GraphQLFieldConfig<any, any>): FieldDefinitionNode {
    return {
      ...astNode,
      arguments: astNode.arguments?.filter((a) => {
        const arg = field.args?.[a.name.value];
        return arg != null && this.isIncluded(arg) && this.isIncluded(getNamedType(arg.type));
      }),
    };
  }

  private filterFieldConfigArgumentMap(args: GraphQLFieldConfigArgumentMap): GraphQLFieldConfigArgumentMap {
    return Object.fromEntries(
      Object.entries(args)
        .map(([key, arg]) => {
          if (this.isIncluded(arg)) {
            const { type, wrappers } = unwrapType(arg.type);
            const newType = this.typeMap.get(type);
            if (newType) {
              const type = wrapType(newType, wrappers);
              return [key, { ...arg, type }];
            }
          }
        })
        .filter(notNull)
    );
  }

  private filterUnionType(type: GraphQLUnionType): GraphQLUnionType {
    const config = type.toConfig();
    return new GraphQLUnionType({
      ...config,
      types: () => mapTypes(config.types, this.typeMap),
      astNode: config.astNode && this.filterUnionTypeNode(config.astNode),
    });
  }

  private filterUnionTypeNode(astNode: UnionTypeDefinitionNode): UnionTypeDefinitionNode {
    return {
      ...astNode,
      types: astNode.types?.filter((t) => this.typeNames.has(t.name.value)),
    };
  }

  private filterEnumType(type: GraphQLEnumType): GraphQLEnumType {
    if (!type.getValues().every((v) => this.isIncluded(v))) {
      const config = type.toConfig();
      return new GraphQLEnumType({
        ...config,
        values: Object.fromEntries(Object.entries(config.values).filter(([_, v]) => this.isIncluded(v))),
        astNode: config.astNode && this.filterEnumTypeNode(config.astNode, type),
      });
    }
    return type;
  }

  private filterEnumTypeNode(astNode: EnumTypeDefinitionNode, type: GraphQLEnumType): EnumTypeDefinitionNode {
    return {
      ...astNode,
      values: astNode.values?.filter((v) => {
        const value = type.getValue(v.name.value);
        return value != null && this.isIncluded(value);
      }),
    };
  }

  private filterInputObjectType(type: GraphQLInputObjectType): GraphQLInputObjectType {
    const config = type.toConfig();
    return new GraphQLInputObjectType({
      ...config,
      fields: () => this.filterInputFieldConfigMap(config.fields),
      astNode: config.astNode && this.filterInputObjectTypeNode(config.astNode, type),
    });
  }

  private filterInputObjectTypeNode(
    astNode: InputObjectTypeDefinitionNode,
    type: GraphQLInputObjectType
  ): InputObjectTypeDefinitionNode {
    return {
      ...astNode,
      fields: astNode.fields?.filter((f) => {
        const field = type.getFields()[f.name.value];
        return field != null && this.isIncluded(field) && this.isIncluded(getNamedType(field.type));
      }),
    };
  }

  private filterInputFieldConfigMap(fields: GraphQLInputFieldConfigMap): GraphQLInputFieldConfigMap {
    return Object.fromEntries(
      Object.entries(fields)
        .map(([key, field]) => {
          if (this.isIncluded(field)) {
            const { type, wrappers } = unwrapType(field.type);
            const newType = this.typeMap.get(type);
            if (newType) {
              const type = wrapType(newType, wrappers);
              return [key, { ...field, type }];
            }
          }
        })
        .filter(notNull)
    );
  }

  private filterDirective(type: GraphQLDirective): GraphQLDirective {
    const config = type.toConfig();
    return new GraphQLDirective({
      ...config,
      args: config.args && this.filterFieldConfigArgumentMap(config.args),
    });
  }

  private isIncluded(type: WithDirectives): boolean {
    const dir = findFirstDirective(type, this.config.audienceDirective);
    if (dir) {
      const include = getDirectiveArgument(dir, 'include');
      if (include) {
        const included = getStringValues(include.value);
        return included.includes(this.audience);
      }
      const exclude = getDirectiveArgument(dir, 'exclude');
      if (exclude) {
        const excluded = getStringValues(exclude.value);
        return !excluded.includes(this.audience);
      }
    }
    return true;
  }
}

function getStringValues(n: ValueNode): string[] {
  if (isStringValueNode(n)) {
    return [n.value];
  }
  if (isListValueNode(n)) {
    return n.values.flatMap(getStringValues);
  }
  return [];
}

function isListValueNode(n: ValueNode): n is ListValueNode {
  return n.kind === 'ListValue';
}

function isStringValueNode(n: ValueNode): n is StringValueNode {
  return n.kind === 'StringValue';
}

function mapTypes<T extends GraphQLNamedType>(types: T[], typeMap: TypeMap): T[] {
  return types.map((t) => mapType(t, typeMap)).filter(notNull);
}

function mapType<T extends GraphQLNamedType>(type: T, typeMap: TypeMap): T | undefined {
  return typeMap.get(type) as T;
}

function notNull<T>(value: T | null | undefined): value is T {
  return value != null;
}
