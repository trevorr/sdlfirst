import { GraphQLInterfaceType, GraphQLObjectType, GraphQLSchema, isInterfaceType, isObjectType } from 'graphql';
import { mergeSchemas } from 'graphql-tools';
import { defaultConfig, SqlConfig } from './config/SqlConfig';
import { hasDirectives } from './util/ast-util';

export class InternalIdBuilder {
  private readonly config: SqlConfig;

  constructor(private readonly schema: GraphQLSchema, config?: Partial<SqlConfig>) {
    this.config = Object.assign({}, defaultConfig, config);
  }

  public addInternalIds(): GraphQLSchema {
    let extSource = '';
    for (const type of Object.values(this.schema.getTypeMap())) {
      let kind;
      if (isObjectType(type)) {
        kind = 'type';
      } else if (isInterfaceType(type)) {
        kind = 'interface';
      } else {
        continue;
      }
      if (this.hasInternalId(type)) {
        extSource += `extend ${kind} ${type.name} { ${this.config.autoIncrementFieldName}: ${this.config.autoIncrementFieldType} @id @autoinc }\n`;
      }
    }
    if (!extSource) return this.schema;

    const schema = mergeSchemas({
      schemas: [this.schema],
      typeDefs: extSource,
    });
    // filter out duplicate directives: https://github.com/ardatan/graphql-tools/issues/2031
    for (const type of Object.values(schema.getTypeMap())) {
      if (type.astNode?.directives) {
        const dirSet = new Set<string>();
        type.astNode = { ...type.astNode, directives: type.astNode.directives.filter((dirNode) => {
          const name = dirNode.name.value;
          if (dirSet.has(name)) return false;
          dirSet.add(name);
          return true;
        }) };
      }
    }
    return schema;
  }

  private hasInternalId(type: GraphQLInterfaceType | GraphQLObjectType): boolean {
    for (const field of Object.values(type.getFields())) {
      if (hasDirectives(field, [this.config.randomIdDirective, this.config.wkidDirective])) {
        return true;
      }
    }
    return false;
  }
}
