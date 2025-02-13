import { ConstDirectiveNode, DirectiveNode } from 'graphql';

export interface WithConstDirectives {
  readonly directives?: ReadonlyArray<ConstDirectiveNode>;
}

export interface WithDirectives {
  readonly directives?: ReadonlyArray<DirectiveNode>;
}

export function findDirective(node: WithConstDirectives, name: string): ConstDirectiveNode | undefined;
export function findDirective(node: WithDirectives, name: string): DirectiveNode | undefined;
export function findDirective(node: WithDirectives, name: string): DirectiveNode | undefined {
  return node.directives ? node.directives.find((d) => d.name.value === name) : undefined;
}

export function hasDirective(node: WithDirectives, name: string): boolean {
  return findDirective(node, name) != null;
}

export function hasDirectives(node: WithDirectives, names: Iterable<string>): boolean {
  if (node.directives) {
    const nameSet = names instanceof Set ? names : new Set(names);
    return node.directives.some((d) => nameSet.has(d.name.value));
  }
  return false;
}
