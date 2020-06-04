import { ArgumentNode, ASTNode, DirectiveNode, Location } from 'graphql';

interface WithDirectives {
  astNode?: {
    readonly directives?: ReadonlyArray<DirectiveNode>;
  } | null;
}

export function findFirstDirective(type: WithDirectives, name: string): DirectiveNode | undefined {
  return type.astNode && type.astNode.directives
    ? type.astNode.directives.find((d) => d.name.value === name)
    : undefined;
}

export function findDirectives(type: WithDirectives, name: string): DirectiveNode[] {
  return type.astNode && type.astNode.directives ? type.astNode.directives.filter((d) => d.name.value === name) : [];
}

export function hasDirective(type: WithDirectives, name: string): boolean {
  return findFirstDirective(type, name) != null;
}

export function hasDirectives(type: WithDirectives, names: Iterable<string>): boolean {
  if (type.astNode && type.astNode.directives) {
    const nameSet = names instanceof Set ? names : new Set(names);
    return type.astNode.directives.some((d) => nameSet.has(d.name.value));
  }
  return false;
}

export function getDirectiveArgument(directive: DirectiveNode, name: string): ArgumentNode | undefined {
  return directive.arguments ? directive.arguments.find((a) => a.name.value === name) : undefined;
}

export function getRequiredDirectiveArgument(directive: DirectiveNode, name: string, kind?: string): ArgumentNode {
  const arg = getDirectiveArgument(directive, name);
  if (arg == null) {
    throw new Error(
      `"${name}" argument required for @${directive.name.value} directive${formatLocation(directive.loc)}`
    );
  }
  if (kind && kind !== arg.value.kind) {
    throw new Error(
      `Expected ${kind} but got ${arg.value.kind} for "${name}" argument of ` +
        `@${directive.name.value} directive${formatLocation(directive.loc)}`
    );
  }
  return arg;
}

export function formatLocation(loc: Location | null | undefined): string {
  if (loc) {
    const { startToken: tok } = loc;
    if (tok) {
      return ` at line ${tok.line}, column ${tok.column}`;
    }
    return ` at offset ${loc.start}`;
  }
  return '';
}

export function formatLocationOf(astNode: ASTNode | null | undefined): string {
  return formatLocation(astNode ? astNode.loc : null);
}
