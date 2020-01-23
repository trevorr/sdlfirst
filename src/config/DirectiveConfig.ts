export interface DirectiveConfig {
  createdAtDirective: string;
  createDirective: string;
  createNestedDirective: string;
  defaultDirective: string;
  deleteDirective: string;
  derivedDirective: string;
  externalIdDirective: string;
  generatedDefaultDirective: string;
  immutableDirective: string;
  internalIdDirective: string;
  lengthDirective: string;
  newManyToManyDirective: string;
  oneToManyDirective: string;
  readonlyDirective: string;
  sqlColumnDirective: string;
  sqlTableDirective: string;
  sqlTypeDirective: string;
  sqlValueDirective: string;
  stringIdDirective: string;
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
  generatedDefaultDirective: 'generatedDefault',
  immutableDirective: 'immutable',
  internalIdDirective: 'id',
  lengthDirective: 'length',
  newManyToManyDirective: 'newManyToMany',
  oneToManyDirective: 'oneToMany',
  readonlyDirective: 'readonly',
  sqlColumnDirective: 'sqlColumn',
  sqlTableDirective: 'sqlTable',
  sqlTypeDirective: 'sqlType',
  sqlValueDirective: 'sqlValue',
  stringIdDirective: 'sid',
  typeDiscriminatorDirective: 'typeDiscriminator',
  uniqueDirective: 'unique',
  updatedAtDirective: 'updatedAt',
  updateDirective: 'update',
  updateNestedDirective: 'updateNested',
  useManyToManyDirective: 'useManyToMany'
};
