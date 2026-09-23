import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Raiz do repositório — o harness lê o projeto inteiro, não só `src/`. */
export const REPO_ROOT = join(__dirname, '..', '..', '..');
export const SRC_ROOT = join(REPO_ROOT, 'src');

const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'coverage',
  'generated',
  '.git',
]);

export type SourceFile = {
  /** Caminho relativo à raiz do repositório, sempre com `/`. */
  path: string;
  absolutePath: string;
  content: string;
};

/** Todos os `.ts` sob `directory`, exceto declarações e o que não é código. */
export function listTypeScriptFiles(directory: string): string[] {
  const found: string[] = [];

  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      if (IGNORED_DIRECTORIES.has(entry)) continue;

      const absolute = join(current, entry);
      if (statSync(absolute).isDirectory()) {
        walk(absolute);
        continue;
      }

      if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
        found.push(absolute);
      }
    }
  };

  walk(directory);
  return found.sort();
}

export function readSourceFiles(
  directory: string,
  filter: (file: SourceFile) => boolean = () => true,
): SourceFile[] {
  return listTypeScriptFiles(directory)
    .map((absolutePath) => ({
      absolutePath,
      path: toPosix(relative(REPO_ROOT, absolutePath)),
      content: readFileSync(absolutePath, 'utf8'),
    }))
    .filter(filter);
}

export function toPosix(path: string): string {
  return path.split(sep).join('/');
}

/** Os caminhos importados por um arquivo — `import … from 'x'` e `require('x')`. */
export function importedModules(content: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) specifiers.push(match[1]);
  }

  return specifiers;
}

/** Linhas não vazias e não comentadas — a medida de tamanho que interessa. */
export function significantLineCount(content: string): number {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !line.startsWith('//') &&
        !line.startsWith('*') &&
        !line.startsWith('/*'),
    ).length;
}
