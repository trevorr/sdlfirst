import { codegen } from '@graphql-codegen/core';
import * as typescriptPlugin from '@graphql-codegen/typescript';
import { DocumentNode, GraphQLSchema, parse, printSchema } from 'graphql';
import path from 'path';
import { defaultConfig as defaultPathConfig, PathConfig } from './config/PathConfig';
import { mkdir, writeFile } from './util/fs-util';
import { defaultConfig as defaultFormatterConfig, TsFormatter, TsFormatterConfig } from './util/TsFormatter';

export interface TypesWriterConfig extends PathConfig, TsFormatterConfig {
  scalarTypes: Record<string, string>;
}

export const defaultConfig: TypesWriterConfig = {
  ...defaultPathConfig,
  ...defaultFormatterConfig,
  scalarTypes: {
    Date: 'Date',
    DateTime: 'Date',
    JSON: 'any',
    Time: 'Date',
    URI: 'string',
  },
};

export class TypesWriter {
  private readonly config: TypesWriterConfig;
  private readonly formatter: TsFormatter;

  constructor(private readonly schema: GraphQLSchema, config?: Partial<TypesWriterConfig>) {
    this.config = Object.assign({}, defaultConfig, config);
    this.formatter = new TsFormatter(config);
  }

  public async writeTypes(document?: DocumentNode): Promise<string[]> {
    const { baseDir, sdlTypesDir, sdlTypesFile, scalarTypes } = this.config;
    const outputDir = path.join(baseDir, sdlTypesDir);
    const outputFile = path.join(outputDir, sdlTypesFile);
    const config = {
      config: {
        scalars: scalarTypes,
      },
      documents: [],
      filename: outputFile,
      plugins: [
        {
          typescript: {},
        },
      ],
      pluginMap: {
        typescript: typescriptPlugin,
      },
      schema: document || parse(printSchema(this.schema)),
    };
    await mkdir(outputDir, { recursive: true });
    const source = await codegen(config);
    const output = await this.formatter.format(source, outputFile);
    await writeFile(outputFile, output);
    return [outputFile];
  }
}
