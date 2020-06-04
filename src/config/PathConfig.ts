export interface PathConfig {
  baseDir: string;
  databaseMetadataDir: string;
  databaseSchemaDir: string;
  enumMappingsDir: string;
  fieldVisitorsDir: string;
  resolversDir: string;
  sdlOutputDir: string;
  sdlOutputFile: string;
  sdlTypesDir: string;
  sdlTypesFile: string;
  sqlExtension: string;
  typescriptExtension: string;
}

export const defaultConfig: PathConfig = {
  baseDir: '.',
  databaseMetadataDir: 'dbmeta',
  databaseSchemaDir: 'dbschema',
  enumMappingsDir: 'enums',
  fieldVisitorsDir: 'visitors',
  resolversDir: 'resolvers',
  sdlOutputDir: 'genschema',
  sdlOutputFile: 'schema.graphql',
  sdlTypesDir: 'types',
  sdlTypesFile: 'index.ts',
  sqlExtension: '.sql',
  typescriptExtension: '.ts',
};
