import {
  GraphQLSchema,
  isSpecifiedDirective,
  isSpecifiedScalarType,
  OperationTypeDefinitionNode,
  print,
  printType,
  SchemaDefinitionNode
} from 'graphql';

function getSchemaAstNode(schema: GraphQLSchema): SchemaDefinitionNode {
  if (schema.astNode) {
    return schema.astNode;
  }
  const operationTypes: OperationTypeDefinitionNode[] = [];
  const queryType = schema.getQueryType();
  if (queryType) {
    operationTypes.push({
      kind: 'OperationTypeDefinition',
      operation: 'query',
      type: { kind: 'NamedType', name: { kind: 'Name', value: queryType.name } }
    });
  }
  const mutationType = schema.getMutationType();
  if (mutationType) {
    operationTypes.push({
      kind: 'OperationTypeDefinition',
      operation: 'mutation',
      type: { kind: 'NamedType', name: { kind: 'Name', value: mutationType.name } }
    });
  }
  const subscriptionType = schema.getSubscriptionType();
  if (subscriptionType) {
    operationTypes.push({
      kind: 'OperationTypeDefinition',
      operation: 'subscription',
      type: { kind: 'NamedType', name: { kind: 'Name', value: subscriptionType.name } }
    });
  }
  return {
    kind: 'SchemaDefinition',
    operationTypes
  };
}

export function printSchemaUsingAst(schema: GraphQLSchema): string {
  const directives = schema
    .getDirectives()
    .filter(dir => !isSpecifiedDirective(dir))
    .map(dir => (dir.astNode ? print(dir.astNode) : `# directive @${dir.name}`));

  const types = Object.entries(schema.getTypeMap())
    .filter(([name]) => !name.match(/^__/))
    .map(([, type]) => type)
    .filter(type => !isSpecifiedScalarType(type))
    .sort((type1, type2) => type1.name.localeCompare(type2.name))
    .map(type => (type.astNode ? print(type.astNode) : printType(type)));

  return [print(getSchemaAstNode(schema))].concat(directives, types).join('\n\n') + '\n';
}
