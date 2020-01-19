import { codegen } from '@graphql-codegen/core';
import * as typescriptPlugin from '@graphql-codegen/typescript';
import { DocumentNode, GraphQLSchema, parse, printSchema } from 'graphql';
import path from 'path';
import { defaultConfig as defaultPathConfig, PathConfig } from './config/PathConfig';
import { mkdir, writeFile } from './util/fs-util';

export interface TypesWriterConfig extends PathConfig {
  scalarTypes: Record<string, string>;
}

export const defaultConfig: TypesWriterConfig = {
  ...defaultPathConfig,
  scalarTypes: {
    Date: 'string',
    DateTime: 'Date | string',
    JSON: 'any',
    Time: 'string',
    URI: 'URL | string'
  }
};

export class TypesWriter {
  private readonly config: TypesWriterConfig;

  constructor(private readonly schema: GraphQLSchema, config?: Partial<TypesWriterConfig>) {
    this.config = Object.assign({}, defaultConfig, config);
  }

  public async writeTypes(document?: DocumentNode): Promise<string[]> {
    const { baseDir, sdlTypesDir, sdlTypesFile, scalarTypes } = this.config;
    const outputDir = path.join(baseDir, sdlTypesDir);
    const outputFile = path.join(outputDir, sdlTypesFile);
    const config = {
      config: {
        scalars: scalarTypes
      },
      documents: [],
      filename: outputFile,
      plugins: [
        {
          typescript: {}
        }
      ],
      pluginMap: {
        typescript: typescriptPlugin
      },
      schema: document || parse(printSchema(this.schema))
    };
    await mkdir(outputDir, { recursive: true });
    const output = await codegen(config);
    await writeFile(outputFile, output);
    return [outputFile];
  }
}
