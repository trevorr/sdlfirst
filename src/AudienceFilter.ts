import { DocumentNode, Kind, NamedTypeNode, ValueNode, visit } from 'graphql';
import { DirectiveConfig } from './config/DirectiveConfig';
import { getDirectiveArgument } from './util/ast-util';
import { findDirective, WithDirectives } from './util/astNode-util';
import { buildNamedDefinitionMap } from './util/namedDefinitionMap';

export class AudienceFilter {
  constructor(
    private readonly schemaAst: DocumentNode,
    private readonly config: DirectiveConfig,
    private readonly audience: string
  ) {}

  public filterAudience(): DocumentNode {
    // Necessary to access object `this` in the visit functions
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    const schemaMap = buildNamedDefinitionMap(this.schemaAst);

    function isReferenceIncluded(ref: NamedTypeNode): boolean {
      const node = schemaMap.get(ref.name.value);
      return node?.kind === Kind.OBJECT_TYPE_DEFINITION || node?.kind === Kind.INTERFACE_TYPE_DEFINITION
        ? self.isIncluded(node)
        : true;
    }

    return visit(this.schemaAst, {
      InputObjectTypeDefinition(node) {
        return self.isIncluded(node) ? node : null;
      },
      ObjectTypeDefinition(node) {
        if (!self.isIncluded(node)) {
          return null;
        }
        // Filter out interfaces that are not included
        if (node.interfaces?.some((i) => !isReferenceIncluded(i))) {
          return {
            ...node,
            interfaces: node.interfaces.filter((i) => isReferenceIncluded(i)),
          };
        }
      },
      InterfaceTypeDefinition(node) {
        if (!self.isIncluded(node)) {
          return null;
        }
        // Filter out interfaces that are not included
        if (node.interfaces?.some((i) => !isReferenceIncluded(i))) {
          return {
            ...node,
            interfaces: node.interfaces.filter((i) => isReferenceIncluded(i)),
          };
        }
      },
      FieldDefinition(node) {
        return self.isIncluded(node) ? node : null;
      },
      UnionTypeDefinition(node) {
        if (!self.isIncluded(node)) {
          return null;
        }
        // Filter out types that are not included
        if (node.types?.some((i) => !isReferenceIncluded(i))) {
          return {
            ...node,
            types: node.types.filter((i) => isReferenceIncluded(i)),
          };
        }
      },
      EnumTypeDefinition(node) {
        return self.isIncluded(node) ? node : null;
      },
      EnumValueDefinition(node) {
        return self.isIncluded(node) ? node : null;
      },
      ScalarTypeDefinition(node) {
        return self.isIncluded(node) ? node : null;
      },
    });
  }

  private isIncluded(type: WithDirectives): boolean {
    const dir = findDirective(type, this.config.audienceDirective);
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
  if (n.kind === Kind.STRING) {
    return [n.value];
  }
  if (n.kind === Kind.LIST) {
    return n.values.flatMap(getStringValues);
  }
  return [];
}
