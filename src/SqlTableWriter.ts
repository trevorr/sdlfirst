import path from 'path';
import { defaultConfig, PathConfig } from './config/PathConfig';
import { formatTable, SqlTable } from './model/SqlTable';
import { mkdir, writeFile } from './util/fs-util';

export class SqlTableWriter {
  private readonly config: PathConfig;

  constructor(config?: Partial<PathConfig>) {
    this.config = Object.assign({}, defaultConfig, config);
  }

  public async writeTables(tables: Iterable<SqlTable>): Promise<string[]> {
    const files = [];
    const { baseDir, databaseSchemaDir, sqlExtension } = this.config;
    const dir = path.join(baseDir, databaseSchemaDir);
    await mkdir(dir, { recursive: true });
    for (const table of tables) {
      const filename = path.join(dir, `${table.name}${sqlExtension}`);
      await writeFile(filename, formatTable(table));
      files.push(filename);
    }
    return files;
  }
}
