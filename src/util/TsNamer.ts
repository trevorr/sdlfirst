import ts from 'typescript';

const reservedWords = new Set([
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  // strict mode
  'as',
  'implements',
  'interface',
  'let',
  'package',
  'private',
  'protected',
  'public',
  'static',
  'yield',
]);

export class TsNamer {
  private nameIdMap = new Map<string, ts.Identifier>();
  private userIdMap = new Map<any, ts.Identifier>();

  public constructor(private readonly outerScope?: TsNamer) {}

  public createIdentifier(name: string, user?: any): ts.Identifier {
    if (user) {
      const id = this.userIdMap.get(user);
      if (id) {
        return id;
      }
    }
    if (reservedWords.has(name)) {
      name = `_${name}`;
    }
    if (this.nameIdMap.has(name)) {
      let counter = 2;
      while (this.nameIdMap.has(`${name}${counter}`)) {
        ++counter;
      }
      name = `${name}${counter}`;
    }
    const id = ts.createIdentifier(name);
    this.nameIdMap.set(name, id);
    if (user) {
      this.userIdMap.set(user, id);
    }
    return id;
  }

  public findIdentifier(name: string): ts.Identifier | undefined {
    return this.nameIdMap.get(name) || (this.outerScope && this.outerScope.findIdentifier(name));
  }

  public findIdentifierFor(user: any): ts.Identifier | undefined {
    return this.userIdMap.get(user) || (this.outerScope && this.outerScope.findIdentifierFor(user));
  }

  public createBindingElement(
    propertyName: string,
    name: string,
    user?: any,
    initializer?: ts.Expression
  ): ts.BindingElement {
    const id = this.createIdentifier(name, user);
    return ts.createBindingElement(
      undefined,
      ts.idText(id) !== propertyName ? propertyName : undefined,
      id,
      initializer
    );
  }

  public createIdPropertyAssignment(name: string, id?: ts.Identifier): ts.ObjectLiteralElementLike {
    if (!id) {
      id = this.createIdentifier(name);
    }
    return ts.idText(id) !== name ? ts.createPropertyAssignment(name, id) : ts.createShorthandPropertyAssignment(id);
  }
}
