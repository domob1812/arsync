import path from 'path';
import fs from 'fs';

export function findProjectRoot(currentDir: string): string | null {
    let dir = path.resolve(currentDir);
    while (dir !== path.parse(dir).root) {
        if (fs.existsSync(path.join(dir, '.arsync'))) return dir;
        dir = path.dirname(dir);
    }
    if (fs.existsSync(path.join(dir, '.arsync'))) return dir;
    return null;
}
