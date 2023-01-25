import ts from 'typescript';

export interface QueryExpressionBuilder {
  getKnex(): ts.Expression;
  getTableAlias(): string;
  join(tableName: string | ts.Expression, tableAlias: string): JoinBuilder;
  joinOn(tableName: string | ts.Expression, tableAlias: string, on: ts.Expression): QueryExpressionBuilder;
  where(column: string, expr: ts.Expression, tableAlias?: string): this;
  whereNull(column: string, tableAlias?: string): this;
  select(column: string, tableAlias?: string): this;
}

export interface JoinBuilder {
  onColumn(toColumn: string | ts.Expression, fromColumn: string, fromTableAlias?: string): this;
  onValue(toValue: string | ts.Expression, fromColumn: string, fromTableAlias?: string): this;
  endJoin(): QueryExpressionBuilder;
}

class NestedQueryExpressionBuilder implements QueryExpressionBuilder {
  public constructor(private readonly outer: QueryExpressionBuilder, private readonly tableAlias: string) {}

  public getKnex(): ts.Expression {
    return this.outer.getKnex();
  }

  public getTableAlias(): string {
    return this.tableAlias;
  }

  public join(tableName: string | ts.Expression, tableAlias: string): JoinBuilder {
    return this.outer.join(tableName, tableAlias);
  }

  public joinOn(tableName: string | ts.Expression, tableAlias: string, on: ts.Expression): this {
    this.outer.joinOn(tableName, tableAlias, on);
    return this;
  }

  public where(column: string, expr: ts.Expression, tableAlias: string = this.tableAlias): this {
    this.outer.where(column, expr, tableAlias);
    return this;
  }

  public whereNull(column: string, tableAlias: string = this.tableAlias): this {
    this.outer.whereNull(column, tableAlias);
    return this;
  }

  public select(column: string, tableAlias: string = this.tableAlias): this {
    this.outer.select(column, tableAlias);
    return this;
  }
}

class JoinBuilderImpl implements JoinBuilder {
  private readonly properties: ts.ObjectLiteralElementLike[] = [];

  public constructor(
    private readonly qeb: QueryExpressionBuilder,
    private readonly tableName: string | ts.Expression,
    private readonly tableAlias: string
  ) {}

  public onColumn(
    toColumn: string | ts.Expression,
    fromColumn: string,
    fromTableAlias: string = this.qeb.getTableAlias()
  ): this {
    const toColumnExpr =
      typeof toColumn === 'string'
        ? ts.factory.createStringLiteral(`${this.tableAlias}.${toColumn}`)
        : ts.factory.createTemplateExpression(ts.factory.createTemplateHead(`${this.tableAlias}.`), [
            ts.factory.createTemplateSpan(toColumn, ts.factory.createTemplateTail('')),
          ]);
    this.addProperty(fromTableAlias, fromColumn, toColumnExpr);
    return this;
  }

  public onValue(
    toValue: string | ts.Expression,
    fromColumn: string,
    fromTableAlias: string = this.qeb.getTableAlias()
  ): this {
    const toValueExpr = ts.factory.createCallExpression(
      ts.factory.createPropertyAccessExpression(this.qeb.getKnex(), 'raw'),
      undefined,
      [
        ts.factory.createStringLiteral('?'),
        ts.factory.createArrayLiteralExpression([
          typeof toValue === 'string' ? ts.factory.createStringLiteral(toValue) : toValue,
        ]),
      ]
    );
    this.addProperty(fromTableAlias, fromColumn, toValueExpr);
    return this;
  }

  private addProperty(fromTableAlias: string, fromColumn: string, expr: ts.Expression): void {
    this.properties.push(
      ts.factory.createPropertyAssignment(ts.factory.createStringLiteral(`${fromTableAlias}.${fromColumn}`), expr)
    );
  }

  public endJoin(): QueryExpressionBuilder {
    return this.qeb.joinOn(this.tableName, this.tableAlias, ts.factory.createObjectLiteralExpression(this.properties));
  }
}

export class RootQueryExpressionBuilder implements QueryExpressionBuilder {
  private expr: ts.Expression;

  public constructor(
    private readonly knex: ts.Expression,
    trx: ts.Expression = knex,
    tableName: string,
    private readonly tableAlias: string = tableName
  ) {
    this.expr = ts.factory.createCallExpression(trx, undefined, [
      ts.factory.createStringLiteral(this.aliasTable(tableName, tableAlias)),
    ]);
  }

  public getKnex(): ts.Expression {
    return this.knex;
  }

  public getTableAlias(): string {
    return this.tableAlias;
  }

  public getExpression(): ts.Expression {
    return this.expr;
  }

  public join(tableName: string | ts.Expression, tableAlias: string): JoinBuilder {
    return new JoinBuilderImpl(this, tableName, tableAlias);
  }

  public joinOn(tableName: string | ts.Expression, tableAlias: string, on: ts.Expression): QueryExpressionBuilder {
    this.callMethod('join', [this.aliasTableExpr(tableName, tableAlias), on]);
    return new NestedQueryExpressionBuilder(this, tableAlias);
  }

  public where(column: string, expr: ts.Expression, tableAlias: string = this.tableAlias): this {
    this.callMethod('where', [ts.factory.createStringLiteral(`${tableAlias}.${column}`), expr]);
    return this;
  }

  public whereNull(column: string, tableAlias: string = this.tableAlias): this {
    this.callMethod('whereNull', [ts.factory.createStringLiteral(`${tableAlias}.${column}`)]);
    return this;
  }

  public select(column: string, tableAlias: string = this.tableAlias): this {
    this.callMethod('select', [ts.factory.createStringLiteral(`${tableAlias}.${column}`)]);
    return this;
  }

  private aliasTable(tableName: string, tableAlias: string): string {
    return tableAlias !== tableName ? `${tableName} as ${tableAlias}` : tableName;
  }

  private aliasTableExpr(tableName: string | ts.Expression, tableAlias: string): ts.Expression {
    return typeof tableName === 'string'
      ? ts.factory.createStringLiteral(this.aliasTable(tableName, tableAlias))
      : ts.factory.createTemplateExpression(ts.factory.createTemplateHead(''), [
          ts.factory.createTemplateSpan(tableName, ts.factory.createTemplateTail(` as ${tableAlias}`)),
        ]);
  }

  private callMethod(name: string, args: ts.Expression[]): void {
    this.expr = ts.factory.createCallExpression(
      ts.factory.createPropertyAccessExpression(this.expr, name),
      undefined,
      args
    );
  }
}

/*
  const schema = gql`
    type A {
      b1: B! @id
      b2: B! @id
      c: C! @id
      deleteDate: DateTime @sqlType(type: "timestamp") @softDelete
    }

    type B {
      id: ID! @rid
      deleted: Boolean! @softDelete
    }

    interface C {
      id: ID! @rid
    }

    type D implements C @sqlTable(id: "D") {
      id: ID! @rid
    }

    type E implements C @sqlTable(id: "E") {
      id: ID! @rid
    }
  `;

  rqeb = new RootQueryExpressionBuilder(knexExpr, trxExpr, 'a')
  rqeb.join('b', 'b1').onColumn('id', 'b1_id').endJoin().where('rid', b1RidExpr)
  rqeb.join('b', 'b2').onColumn('id', 'b2_id').endJoin().where('rid', b2RidExpr)
  rqeb.join(tableExpr, 'c').onColumn(idExpr, 'c_id').onValue(valueExpr, 'c_kind').endJoin().where('rid', cRidExpr)
  rqeb.whereNull('delete_date')
    .select('b1_id')
    .select('b2_id')
    .select('c_kind')
    .select('c_id')
  ->
  trx("a")
    .join("b as b1", { "a.b1_id": "b1.id" })
    .where("b1.rid", b1Rid)
    .join("b as b2", { "a.b2_id": "b2.id" })
    .where("b2.rid", b2Rid)
    .join(`${table} as c`, { "a.c_id": `c.${id}`, "a.c_kind": knex.raw('?', [value]) })
    .where("c.rid", cRid)
    .whereNull("a.delete_date")
    .select("a.b1_id")
    .select("a.b2_id")
    .select('a.c_kind')
    .select('a.c_id')
*/
