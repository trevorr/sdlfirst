import { ArgumentNode, ASTNode, ConstArgumentNode, ConstDirectiveNode, DirectiveNode, Location } from 'graphql';

export interface WithConstDirectives {
  astNode?: {
    readonly directives?: ReadonlyArray<ConstDirectiveNode>;
  } | null;
}

export interface WithDirectives {
  astNode?: {
    readonly directives?: ReadonlyArray<DirectiveNode>;
  } | null;
}

export function findDirective(type: WithConstDirectives, name: string): ConstDirectiveNode | undefined;
export function findDirective(type: WithDirectives, name: string): DirectiveNode | undefined;
export function findDirective(type: WithDirectives, name: string): DirectiveNode | undefined {
  return type.astNode && type.astNode.directives
    ? type.astNode.directives.find((d) => d.name.value === name)
    : undefined;
}

export function hasDirective(type: WithDirectives, name: string): boolean {
  return findDirective(type, name) != null;
}

export function hasDirectives(type: WithDirectives, names: Iterable<string>): boolean {
  if (type.astNode && type.astNode.directives) {
    const nameSet = names instanceof Set ? names : new Set(names);
    return type.astNode.directives.some((d) => nameSet.has(d.name.value));
  }
  return false;
}

export function hasDirectiveFlag(directive: DirectiveNode, name: string): boolean {
  const arg = getDirectiveArgument(directive, name);
  return arg != null && arg.value.kind === 'BooleanValue' && arg.value.value;
}

export function getDirectiveArgument(directive: ConstDirectiveNode, name: string): ConstArgumentNode | undefined;
export function getDirectiveArgument(directive: DirectiveNode, name: string): ArgumentNode | undefined;
export function getDirectiveArgument(directive: DirectiveNode, name: string): ArgumentNode | undefined {
  return directive.arguments ? directive.arguments.find((a) => a.name.value === name) : undefined;
}

export function getRequiredDirectiveArgument(
  directive: ConstDirectiveNode,
  name: string,
  kind?: string
): ConstArgumentNode;
export function getRequiredDirectiveArgument(directive: DirectiveNode, name: string, kind?: string): ArgumentNode;
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
