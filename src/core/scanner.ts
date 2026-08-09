import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { stableId } from "./ids.js";
import { readConfig, writeGraph } from "./store.js";
import { toProjectPath } from "./paths.js";
import type {
  GraphEdge,
  GraphNode,
  NodeKind,
  ProofReplayConfig,
  RepositoryGraph
} from "../types.js";

type CallableNode =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.ArrowFunction
  | ts.FunctionExpression;

interface CallReference {
  source: GraphNode;
  name: string;
  file: string;
}

interface ImportReference {
  source: string;
  target: string;
}

function collectFiles(root: string, config: ProofReplayConfig): string[] {
  const files: string[] = [];
  const extensions = new Set(config.sourceExtensions);
  const excluded = new Set(config.exclude);

  function walk(directory: string): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (excluded.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(absolute);
      else if (extensions.has(path.extname(entry.name)) && !entry.name.endsWith(".d.ts")) {
        files.push(absolute);
      }
    }
  }

  walk(root);
  return files.sort();
}

function scriptKind(file: string): ts.ScriptKind {
  const extension = path.extname(file);
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if (extension === ".ts") return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function lineOf(sourceFile: ts.SourceFile, position: number): number {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

function propertyName(
  node: ts.PropertyName | ts.BindingName | undefined,
  sourceFile: ts.SourceFile
): string {
  if (!node) return "anonymous";
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  return node.getText(sourceFile).replaceAll(/["']/g, "");
}

function enclosingClassName(node: ts.Node): string | null {
  let parent = node.parent;
  while (parent) {
    if (ts.isClassDeclaration(parent) || ts.isClassExpression(parent)) {
      return parent.name?.text ?? "anonymous-class";
    }
    parent = parent.parent;
  }
  return null;
}

function callableName(node: CallableNode, sourceFile: ts.SourceFile): string {
  if (ts.isFunctionDeclaration(node)) return node.name?.text ?? "anonymous";
  if (
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    const name = ts.isConstructorDeclaration(node)
      ? "constructor"
      : propertyName(node.name, sourceFile);
    const owner = enclosingClassName(node);
    return owner ? `${owner}.${name}` : name;
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    if (ts.isVariableDeclaration(node.parent)) return propertyName(node.parent.name, sourceFile);
    if (ts.isPropertyAssignment(node.parent)) return propertyName(node.parent.name, sourceFile);
    if (ts.isBinaryExpression(node.parent)) return node.parent.left.getText(sourceFile);
  }
  return "anonymous";
}

function isCallable(node: ts.Node): node is CallableNode {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node)
  );
}

function callName(
  expression: ts.LeftHandSideExpression,
  sourceFile: ts.SourceFile
): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression)) return expression.argumentExpression?.getText(sourceFile);
  return null;
}

function isTestCall(node: ts.Node, sourceFile: ts.SourceFile): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const text = node.expression.getText(sourceFile);
  return /^(test|it)(\.(only|skip|todo))?$/.test(text);
}

function testTitle(node: ts.CallExpression): string {
  const first = node.arguments[0];
  if (!first) return "unnamed test";
  if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) return first.text;
  return first.getText().slice(0, 80);
}

function resolveRelativeImport(
  sourceFile: string,
  specifier: string,
  knownFiles: ReadonlySet<string>
): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(sourceFile), specifier);
  const candidates = [
    base,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.js"),
    path.join(base, "index.ts"),
    path.join(base, "index.tsx")
  ];
  return candidates.find((candidate) => knownFiles.has(path.resolve(candidate))) ?? null;
}

function addEdge(
  edges: GraphEdge[],
  seen: Set<string>,
  source: string | undefined,
  target: string | undefined,
  kind: GraphEdge["kind"],
  data: Record<string, unknown> = {}
): void {
  if (!source || !target || source === target) return;
  const key = `${source}\u0000${target}\u0000${kind}`;
  if (seen.has(key)) return;
  seen.add(key);
  edges.push({ id: stableId("edge", key), source, target, kind, data });
}

export function scanProject(root: string): RepositoryGraph {
  const config = readConfig(root);
  const absoluteFiles = collectFiles(root, config);
  const knownFiles = new Set(absoluteFiles.map((file) => path.resolve(file)));
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const edgeKeys = new Set<string>();
  const calls: CallReference[] = [];
  const imports: ImportReference[] = [];
  const callableByName = new Map<string, GraphNode[]>();
  const fileIds = new Map<string, string>();

  for (const absoluteFile of absoluteFiles) {
    const relativeFile = toProjectPath(root, absoluteFile);
    const fileId = stableId("file", relativeFile);
    fileIds.set(path.resolve(absoluteFile), fileId);
    nodes.push({
      id: fileId,
      kind: "file",
      label: path.basename(relativeFile),
      file: relativeFile,
      line: 1,
      start: 0,
      end: fs.statSync(absoluteFile).size,
      data: { path: relativeFile }
    });
  }

  for (const absoluteFile of absoluteFiles) {
    const relativeFile = toProjectPath(root, absoluteFile);
    const fileId = fileIds.get(path.resolve(absoluteFile))!;
    const sourceText = fs.readFileSync(absoluteFile, "utf8");
    const sourceFile = ts.createSourceFile(
      absoluteFile,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(absoluteFile)
    );

    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const target = resolveRelativeImport(absoluteFile, statement.moduleSpecifier.text, knownFiles);
        const targetId = target ? fileIds.get(path.resolve(target)) : undefined;
        if (targetId) imports.push({ source: fileId, target: targetId });
      }
    }

    function registerCallable(
      node: ts.Node,
      kind: NodeKind = "function",
      labelOverride?: string
    ): GraphNode {
      const name = labelOverride ?? (isCallable(node) ? callableName(node, sourceFile) : "anonymous");
      const start = node.getStart(sourceFile);
      const id = stableId(kind, relativeFile, String(start), name);
      const item: GraphNode = {
        id,
        kind,
        label: name,
        file: relativeFile,
        line: lineOf(sourceFile, start),
        start,
        end: node.end,
        data: {
          name,
          displayPath: `${relativeFile}:${lineOf(sourceFile, start)}`
        }
      };
      nodes.push(item);
      addEdge(edges, edgeKeys, fileId, id, "contains");
      const simple = name.split(".").at(-1) ?? name;
      if (!callableByName.has(simple)) callableByName.set(simple, []);
      callableByName.get(simple)!.push(item);
      return item;
    }

    function visit(node: ts.Node, currentCallable: GraphNode | null = null): void {
      if (isTestCall(node, sourceFile)) {
        const callback = node.arguments.find(
          (argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)
        );
        const title = testTitle(node);
        const testNode = registerCallable(callback ?? node, "test", title);
        if (callback?.body) visit(callback.body, testNode);
        return;
      }

      if (isCallable(node)) {
        const callable = registerCallable(node);
        if (node.body) visit(node.body, callable);
        return;
      }

      if (ts.isCallExpression(node)) {
        const name = callName(node.expression, sourceFile);
        if (currentCallable && name && !["test", "it", "describe"].includes(name)) {
          calls.push({ source: currentCallable, name, file: relativeFile });
        }

        if (
          ts.isIdentifier(node.expression) &&
          node.expression.text === "require" &&
          node.arguments[0] &&
          ts.isStringLiteral(node.arguments[0])
        ) {
          const target = resolveRelativeImport(absoluteFile, node.arguments[0].text, knownFiles);
          const targetId = target ? fileIds.get(path.resolve(target)) : undefined;
          if (targetId) imports.push({ source: fileId, target: targetId });
        }
      }

      ts.forEachChild(node, (child) => visit(child, currentCallable));
    }

    visit(sourceFile);
  }

  for (const item of imports) addEdge(edges, edgeKeys, item.source, item.target, "imports");

  for (const call of calls) {
    const candidates = callableByName.get(call.name) ?? [];
    const target =
      candidates.find((candidate) => candidate.file === call.file) ??
      (candidates.length === 1 ? candidates[0] : null);
    if (target) addEdge(edges, edgeKeys, call.source.id, target.id, "calls");
  }

  const graph: RepositoryGraph = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    root,
    nodes,
    edges,
    stats: {
      files: nodes.filter((node) => node.kind === "file").length,
      functions: nodes.filter((node) => node.kind === "function").length,
      tests: nodes.filter((node) => node.kind === "test").length,
      edges: edges.length
    }
  };
  writeGraph(root, graph);
  return graph;
}
