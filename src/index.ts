import { DocumentNode, GraphQLSchema } from 'graphql';
import path from 'path';
import { Analyzer } from './Analyzer';
import { AudienceFilter } from './AudienceFilter';
import { defaultConfig as defaultDirectiveConfig, DirectiveConfig } from './config/DirectiveConfig';
import { defaultConfig as defaultPathConfig, PathConfig } from './config/PathConfig';
import { SqlConfig } from './config/SqlConfig';
import { FieldVisitorConfig, FieldVisitorWriter } from './FieldVisitorWriter';
import { InternalIdBuilder } from './InternalIdBuilder';
import { MutationBuilder } from './MutationBuilder';
import { SqlEnumMappingConfig, SqlEnumMappingWriter } from './SqlEnumMappingWriter';
import { SqlMetadataConfig, SqlMetadataWriter } from './SqlMetadataWriter';
import { SqlResolverConfig, SqlResolverWriter } from './SqlResolverWriter';
import { SqlSchemaBuilder, SqlSchemaMappings } from './SqlSchemaBuilder';
import { SqlTableWriter } from './SqlTableWriter';
import { TypesWriter, TypesWriterConfig } from './TypesWriter';
import { mkdir, writeFile } from './util/fs-util';
import { printSchemaUsingAst } from './util/printSchema';

export default class SDLFirst {
  private readonly directiveConfig: DirectiveConfig;
  private analyzer: Analyzer | undefined;
  private sqlMappings: SqlSchemaMappings | undefined;

  constructor(private schema: GraphQLSchema, config?: Partial<DirectiveConfig>) {
    this.directiveConfig = Object.assign({}, defaultDirectiveConfig, config);
  }

  public filterAudience(audience: string): GraphQLSchema {
    return (this.schema = new AudienceFilter(this.schema, this.directiveConfig, audience).filterAudience());
  }

  public addMutations(): GraphQLSchema {
    return (this.schema = new MutationBuilder(this.schema, this.getAnalyzer()).addMutations());
  }

  public addInternalIds(config?: Partial<SqlConfig>): GraphQLSchema {
    return (this.schema = new InternalIdBuilder(this.schema, config).addInternalIds());
  }

  public async writeSchema(config?: Partial<PathConfig>): Promise<string[]> {
    const pathConfig = Object.assign({}, defaultPathConfig, config);
    const { baseDir, sdlOutputDir, sdlOutputFile } = pathConfig;
    const outputDir = path.join(baseDir, sdlOutputDir);
    const outputSource = printSchemaUsingAst(this.schema);
    await mkdir(outputDir, { recursive: true });
    const outputFile = path.join(outputDir, sdlOutputFile);
    await writeFile(outputFile, outputSource);
    return [outputFile];
  }

  public writeTypes(config?: Partial<TypesWriterConfig>, document?: DocumentNode): Promise<string[]> {
    return new TypesWriter(this.schema, config).writeTypes(document);
  }

  public writeEnumMappings(config?: Partial<SqlEnumMappingConfig>): Promise<string[]> {
    return new SqlEnumMappingWriter(this.schema, this.getAnalyzer(), config).writeMappings();
  }

  public writeFieldVisitors(config?: Partial<FieldVisitorConfig>): Promise<string[]> {
    return new FieldVisitorWriter(this.getAnalyzer(), this.getSqlMappings(config), config).writeVisitors();
  }

  public writeResolvers(config?: Partial<SqlResolverConfig>): Promise<string[]> {
    return new SqlResolverWriter(this.schema, this.getAnalyzer(), this.getSqlMappings(config), config).writeResolvers();
  }

  public writeSqlMetadata(config?: Partial<SqlMetadataConfig>): Promise<string[]> {
    return new SqlMetadataWriter(this.getAnalyzer(), this.getSqlMappings(config), config).writeMetadata();
  }

  public writeSqlTables(config?: Partial<SqlConfig & PathConfig>): Promise<string[]> {
    const tables = this.getSqlMappings(config).tables.map((m) => m.table);
    return new SqlTableWriter(config).writeTables(tables);
  }

  private getAnalyzer(): Analyzer {
    if (!this.analyzer) {
      this.analyzer = new Analyzer(this.schema, this.directiveConfig);
    }
    return this.analyzer;
  }

  private getSqlMappings(config?: Partial<SqlConfig>): SqlSchemaMappings {
    if (!this.sqlMappings) {
      this.sqlMappings = new SqlSchemaBuilder(this.getAnalyzer(), config).generateTables();
    }
    return this.sqlMappings;
  }
}
