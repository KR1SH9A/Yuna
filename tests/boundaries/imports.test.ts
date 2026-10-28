/** Enforce executable ownership boundaries without requiring a dependency-injection framework. */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { expect, test } from '@jest/globals';
import ts from 'typescript';

const root = process.cwd();

/** Read only source files; compiled output and dependencies are outside the dependency graph. */
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}

/** Resolve statically declared local imports/exports using the repository's NodeNext convention. */
function imports(file: string): { target: string; typeOnly: boolean }[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const result: { target: string; typeOnly: boolean }[] = [];
  for (const node of source.statements) {
    if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue;
    const specifier = node.moduleSpecifier;
    if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith('.')) continue;
    const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
    const names = clause?.namedBindings;
    const typeOnly = ts.isExportDeclaration(node) ? node.isTypeOnly
      : Boolean(clause?.isTypeOnly || (clause && !clause.name && names && ts.isNamedImports(names)
        && names.elements.length > 0 && names.elements.every(element => element.isTypeOnly)));
    result.push({ target: relative(root, resolve(dirname(file), specifier.text.replace(/\.js$/, '.ts'))), typeOnly });
  }
  return result;
}

const graph = new Map(sourceFiles(resolve(root, 'src')).concat(sourceFiles(resolve(root, 'apps')))
  .map(file => [relative(root, file), imports(file)]));

test('providers, workers and contexts retain their explicit import boundaries', () => {
  const violations: string[] = [];
  for (const [file, dependencies] of graph) for (const { target } of dependencies) {
    const provider = /^src\/ai\/(llm|jev|embeddings)\//.exec(file)?.[1];
    if (provider && (/^(src\/(contexts|discord|platform\/jobs)|apps)\//.test(target)
      || (/^src\/ai\/(llm|jev|embeddings)\//.test(target) && !target.startsWith(`src/ai/${provider}/`)))) {
      violations.push(`${file} -> ${target}`);
    }
    if (file.startsWith('apps/ai-worker/') && /^src\/(contexts|discord)\//.test(target)) violations.push(`${file} -> ${target}`);
    if (file.startsWith('src/contexts/') && target.startsWith('apps/')) violations.push(`${file} -> ${target}`);
    if (file.startsWith('src/discord/') && (target.startsWith('src/contexts/') || target.startsWith('apps/'))) {
      violations.push(`${file} -> ${target}`);
    }
    if (!graph.has(target)) violations.push(`Unresolved local import: ${file} -> ${target}`);
  }
  expect(violations).toEqual([]);
});

test('runtime source dependencies contain no cycles', () => {
  const visited = new Set<string>();
  const active: string[] = [];
  const cycles: string[] = [];
  /** Track the active path separately from completed nodes to detect actual back edges. */
  function visit(file: string): void {
    const index = active.indexOf(file);
    if (index >= 0) { cycles.push([...active.slice(index), file].join(' -> ')); return; }
    if (visited.has(file)) return;
    active.push(file);
    for (const dependency of graph.get(file) ?? []) if (!dependency.typeOnly) visit(dependency.target);
    active.pop();
    visited.add(file);
  }
  for (const file of graph.keys()) visit(file);
  expect(cycles).toEqual([]);
});
