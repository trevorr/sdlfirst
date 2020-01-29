export interface DirectiveConfig {
  createdAtDirective: string;
  createDirective: string;
  createNestedDirective: string;
  defaultDirective: string;
  deleteDirective: string;
  derivedDirective: string;
  externalIdDirective: string;
  externalIdRefDirective: string;
  floatRangeDirective: string;
  generatedDefaultDirective: string;
  immutableDirective: string;
  internalIdDirective: string;
  intRangeDirective: string;
  lengthDirective: string;
  newManyToManyDirective: string;
  oneToManyDirective: string;
  readonlyDirective: string;
  regexDirective: string;
  sqlColumnDirective: string;
  sqlTableDirective: string;
  sqlTypeDirective: string;
  sqlValueDirective: string;
  stringIdDirective: string;
  stringIdRefDirective: string;
  typeDiscriminatorDirective: string;
  uniqueDirective: string;
  updatedAtDirective: string;
  updateDirective: string;
  updateNestedDirective: string;
  useManyToManyDirective: string;
}

export const defaultConfig: DirectiveConfig = {
  createdAtDirective: 'createdAt',
  createDirective: 'create',
  createNestedDirective: 'createNested',
  defaultDirective: 'default',
  deleteDirective: 'delete',
  derivedDirective: 'derived',
  externalIdDirective: 'xid',
  externalIdRefDirective: 'xidRef',
  floatRangeDirective: 'floatRange',
  generatedDefaultDirective: 'generatedDefault',
  immutableDirective: 'immutable',
  internalIdDirective: 'id',
  intRangeDirective: 'intRange',
  lengthDirective: 'length',
  newManyToManyDirective: 'newManyToMany',
  oneToManyDirective: 'oneToMany',
  readonlyDirective: 'readonly',
  regexDirective: 'regex',
  sqlColumnDirective: 'sqlColumn',
  sqlTableDirective: 'sqlTable',
  sqlTypeDirective: 'sqlType',
  sqlValueDirective: 'sqlValue',
  stringIdDirective: 'sid',
  stringIdRefDirective: 'sidRef',
  typeDiscriminatorDirective: 'typeDiscriminator',
  uniqueDirective: 'unique',
  updatedAtDirective: 'updatedAt',
  updateDirective: 'update',
  updateNestedDirective: 'updateNested',
  useManyToManyDirective: 'useManyToMany'
};
