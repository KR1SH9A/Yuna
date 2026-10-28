/** Keep source navigation readable: every TypeScript file and named implementation needs a purpose comment. */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import ts from 'typescript';

const root = process.cwd();
/** Recurse through project code only; generated output and installed dependencies are intentionally excluded. */
function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}
const gaps = [];
for (const file of ['src', 'apps', 'tests'].flatMap(directory => sourceFiles(resolve(root, directory)))) {
  const text = readFileSync(file, 'utf8'), name = relative(root, file);
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  if ((name.startsWith('src/') || name.startsWith('apps/')) && !source.statements.some(node =>
    !ts.isEmptyStatement(node) && !(ts.isExportDeclaration(node) && !node.moduleSpecifier && node.exportClause
      && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length === 0))) {
    gaps.push(`${name}:1 production file has no implementation or contract; move design-only notes to documentation`);
  }
  if (!/^\s*(\/\*|\/\/)/u.test(text)) gaps.push(`${name}:1 file purpose comment is missing`);
  /** Check named methods/functions, including lifecycle callbacks; ordinary anonymous callback expressions need no repeated labels. */
  function visit(node) {
    const named = ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
      || ts.isGetAccessor(node) || ts.isSetAccessor(node);
    const functionValue = ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration =>
      declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)));
    const preceding = text.slice(node.getFullStart(), node.getStart(source)).trimStart();
    const documented = ts.getLeadingCommentRanges(text, node.getFullStart())?.length || preceding.startsWith('/*') || preceding.startsWith('//');
    if (((named && node.body) || functionValue) && !documented) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      gaps.push(`${name}:${line} ${node.name?.getText(source) ?? (functionValue ? 'function value' : 'constructor')} purpose comment is missing`);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
if (gaps.length) { console.error(gaps.join('\n')); process.exitCode = 1; }
else console.info('File and named-method documentation checks passed. Review comment accuracy alongside code changes.');
