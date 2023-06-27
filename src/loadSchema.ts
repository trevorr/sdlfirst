import { readFile } from 'fs/promises';
import { resolve } from 'path';

import { asError } from 'catch-unknown';
import globby from 'globby';
import { DefinitionNode, DocumentNode, Kind, parse, Source } from 'graphql';

export async function loadSchema(path: string | string[]): Promise<DocumentNode> {
  const definitions: DefinitionNode[] = [];
  const paths = await globby(path);
  if (!paths.length) {
    const resolvedPath = Array.isArray(path) ? path.map((p) => resolve(p)).join(', ') : resolve(path);
    throw new Error(`No schema files found in ${resolvedPath}`);
  }
  for (const path of paths) {
    try {
      const source = new Source(await readFile(path, { encoding: 'utf8' }), path);
      const document = parse(source);
      definitions.push(...document.definitions);
    } catch (err) {
      throw new Error(`Error loading schema file ${path}: ${asError(err).message}`);
    }
  }
  return { kind: Kind.DOCUMENT, definitions };
}
