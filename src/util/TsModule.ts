import fs from 'fs';
import ts from 'typescript';
import util from 'util';
import { compare } from './compare';
import { TsFormatter } from './TsFormatter';
import { TsNamer } from './TsNamer';

const writeFile = util.promisify(fs.writeFile);

interface ImportSpecifier {
  id: ts.Identifier;
  name: string;
}

interface ImportedModule {
  module: string;
  id?: ts.Identifier;
  namedIds?: Map<string, ImportSpecifier>;
  namespaceId?: ts.Identifier;
}

export abstract class TsAbstractBlock extends TsNamer {
  protected readonly statements: ts.Statement[] = [];

  public constructor(outerScope?: TsNamer) {
    super(outerScope);
  }

  public abstract get module(): TsModule;

  public addStatement(statement: ts.Statement): void {
    this.statements.push(statement);
  }

  public isEmpty(): boolean {
    return this.statements.length === 0;
  }

  public toBlock(): ts.Block {
    return ts.createBlock(this.statements, true);
  }

  public declareConst(name: string, type?: ts.TypeNode, initializer?: ts.Expression): ts.Identifier;
  public declareConst<T extends ts.BindingName>(name: T, type?: ts.TypeNode, initializer?: ts.Expression): T;
  public declareConst(name: string | ts.BindingName, type?: ts.TypeNode, initializer?: ts.Expression): ts.BindingName {
    if (typeof name === 'string') {
      name = this.createIdentifier(name);
    }
    this.addStatement(
      ts.createVariableStatement(
        undefined,
        ts.createVariableDeclarationList([ts.createVariableDeclaration(name, type, initializer)], ts.NodeFlags.Const)
      )
    );
    return name;
  }
}

export class TsBlock extends TsAbstractBlock {
  public constructor(public readonly module: TsModule, outerScope: TsNamer) {
    super(outerScope);
  }

  public newBlock(): TsBlock {
    return new TsBlock(this.module, this);
  }
}

export class TsModule extends TsAbstractBlock {
  private readonly modules = new Map<string, ImportedModule>();

  public get module(): TsModule {
    return this;
  }

  public newBlock(): TsBlock {
    return new TsBlock(this, this);
  }

  public addImport(module: string, binding: string): ts.Identifier {
    const purpose = `${module}.default`;
    let id = this.findIdentifierFor(purpose);
    if (!id) {
      const m = this.addModule(module);
      if (!m.id) {
        m.id = this.createIdentifier(binding, purpose);
      }
      id = m.id;
    }
    return id;
  }

  public addNamedImport(module: string, name: string, binding: string = name): ts.Identifier {
    const purpose = `${module}.${name}`;
    let id = this.findIdentifierFor(purpose);
    if (!id) {
      const m = this.addModule(module);
      let { namedIds } = m;
      if (!namedIds) {
        if (m.namespaceId) {
          throw new Error(`Cannot import names from module "${module}" with existing namespace import`);
        }
        m.namedIds = namedIds = new Map();
      }
      let namedId = namedIds.get(binding);
      if (!namedId) {
        namedIds.set(binding, (namedId = { id: this.createIdentifier(binding, purpose), name }));
      }
      id = namedId.id;
    }
    return id;
  }

  public addNamespaceImport(module: string, binding: string): ts.Identifier {
    const purpose = `${module}.*`;
    let id = this.findIdentifierFor(purpose);
    if (!id) {
      const m = this.addModule(module);
      if (!m.namespaceId) {
        if (m.namedIds) {
          throw new Error(`Cannot import namespace from module "${module}" with existing named imports`);
        }
        m.namespaceId = this.createIdentifier(binding, purpose);
      }
      id = m.namespaceId;
    }
    return id;
  }

  private addModule(name: string): ImportedModule {
    let m = this.modules.get(name);
    if (!m) {
      this.modules.set(name, (m = { module: name }));
    }
    return m;
  }

  private buildStatements(): ts.Statement[] {
    return Array.from(this.modules.values())
      .sort(moduleOrder)
      .map(
        (m): ts.Statement =>
          ts.createImportDeclaration(
            undefined,
            undefined,
            ts.createImportClause(
              m.id,
              m.namespaceId
                ? ts.createNamespaceImport(m.namespaceId)
                : m.namedIds
                ? ts.createNamedImports(
                    Array.from(m.namedIds.entries())
                      .sort((a, b) => compare(a[0], b[0]))
                      .map(([binding, spec]) =>
                        ts.createImportSpecifier(
                          binding !== spec.name ? ts.createIdentifier(spec.name) : undefined,
                          spec.id
                        )
                      )
                  )
                : undefined
            ),
            ts.createStringLiteral(m.module)
          )
      )
      .concat(this.statements);
  }

  public async write(path: string, formatter?: TsFormatter): Promise<void> {
    const printer = ts.createPrinter({
      newLine: ts.NewLineKind.LineFeed
    });
    const sourceFile = ts.createSourceFile(path, '', ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
    let source = printer.printList(
      ts.ListFormat.SourceFileStatements,
      ts.createNodeArray(this.buildStatements()),
      sourceFile
    );
    if (formatter) {
      source = await formatter.format(source, path);
    }
    return writeFile(path, source);
  }
}

function moduleOrder(a: ImportedModule, b: ImportedModule): number {
  if (a.module.startsWith('.')) {
    if (!b.module.startsWith('.')) {
      return 1;
    }
  } else if (b.module.startsWith('.')) {
    return -1;
  }
  return compare(a.module, b.module);
}
