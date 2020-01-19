import fs from 'fs';
import util from 'util';

export const mkdir = util.promisify(fs.mkdir);
export const writeFile = util.promisify(fs.writeFile);
