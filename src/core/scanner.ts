import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { stableId } from "./ids.js";
import { readConfig, writeGraph } from "./store.js";
import { toProjectPath } from "./paths.js";
import type {
  ConfidenceLevel,
  GraphEdge,
  GraphNode,
  NodeKind,
  ProjectKind,
  ProjectRelationship,
  ProjectSummary,
  ProofReplayConfig,
  RepositoryGraph,
  RouteDefinition,
  RouteKind
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
  arguments: string[];
  expression: string;
}

interface ImportReference {
  source: string;
  target: string;
  sourceProjectId: string;
  targetProjectId: string;
}

interface RouteReference {
  node: GraphNode;
  projectId: string;
  kind: RouteKind;
  method: string;
  path: string;
  file: string;
  line: number;
  handlerNames: string[];
  confidence: ConfidenceLevel;
  evidence: string;
}

interface ProjectDescriptor {
  id: string;
  name: string;
  path: string;
  absolutePath: string;
  kind: ProjectKind;
  packageName: string | null;
  packageManager: "npm" | "pnpm" | "yarn" | null;
  frameworks: string[];
  manifest: Record<string, unknown> | null;
}

const GENERIC_ROOT_DIRECTORIES = new Set(["src", "lib", "test", "tests", "spec", "specs"]);
const HTTP_METHODS = new Set(["all", "delete", "get", "head", "options", "patch", "post", "put"]);

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
      else if (extensions.has(path.extname(entry.name)) && !entry.name.endsWith(".d.ts")) files.push(absolute);
    }
  }

  walk(root);
  return files.sort();
}

function packageManifest(directory: string): Record<string, unknown> | null {
  const file = path.join(directory, "package.json");
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function packageManager(directory: string, root: string): ProjectDescriptor["packageManager"] {
  for (const candidate of [directory, root]) {
    if (fs.existsSync(path.join(candidate, "pnpm-lock.yaml"))) return "pnpm";
    if (fs.existsSync(path.join(candidate, "yarn.lock"))) return "yarn";
    if (fs.existsSync(path.join(candidate, "package-lock.json"))) return "npm";
  }
  return null;
}

function projectFrameworks(manifest: Record<string, unknown> | null): string[] {
  if (!manifest) return [];
  const dependencies = {
    ...(typeof manifest.dependencies === "object" && manifest.dependencies ? manifest.dependencies : {}),
    ...(typeof manifest.devDependencies === "object" && manifest.devDependencies ? manifest.devDependencies : {})
  } as Record<string, unknown>;
  const candidates: ReadonlyArray<readonly [string, string]> = [
    ["@angular/core", "Angular"], ["@nestjs/core", "NestJS"], ["@playwright/test", "Playwright"],
    ["@remix-run/react", "Remix"], ["express", "Express"], ["fastify", "Fastify"],
    ["hono", "Hono"], ["next", "Next.js"], ["react", "React"], ["react-router-dom", "React Router"],
    ["vite", "Vite"], ["vitest", "Vitest"], ["vue", "Vue"]
  ];
  return candidates.filter(([dependency]) => dependency in dependencies).map(([, label]) => label);
}

function projectKind(relativePath: string, frameworks: string[]): ProjectKind {
  if (relativePath === ".") return "repository";
  if (/(?:^|\/)(?:e2e|test|tests)(?:\/|$)/i.test(relativePath)) return "test";
  if (frameworks.some((item) => ["Express", "Fastify", "Hono", "NestJS"].includes(item))) return "service";
  if (frameworks.some((item) => ["Angular", "Next.js", "React", "Remix", "Vue"].includes(item))) return "application";
  return "package";
}

function discoverProjects(root: string, files: readonly string[], config: ProofReplayConfig): ProjectDescriptor[] {
  const excluded = new Set(config.exclude);
  const manifestDirectories = new Set<string>([root]);

  function walk(directory: string): void {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || excluded.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (fs.existsSync(path.join(absolute, "package.json"))) manifestDirectories.add(absolute);
      walk(absolute);
    }
  }
  walk(root);

  if (manifestDirectories.size > 1) {
    for (const file of files) {
      const relative = toProjectPath(root, file);
      const [topLevel] = relative.split("/");
      if (!topLevel || GENERIC_ROOT_DIRECTORIES.has(topLevel) || topLevel.startsWith(".")) continue;
      const directory = path.join(root, topLevel);
      const ownedByManifest = [...manifestDirectories].some((candidate) => candidate !== root && file.startsWith(`${candidate}${path.sep}`));
      if (!ownedByManifest && fs.statSync(directory).isDirectory()) manifestDirectories.add(directory);
    }
  }

  return [...manifestDirectories].map((absolutePath) => {
    const relativePath = absolutePath === root ? "." : toProjectPath(root, absolutePath);
    const manifest = packageManifest(absolutePath);
    const packageName = typeof manifest?.name === "string" ? manifest.name : null;
    const frameworks = projectFrameworks(manifest);
    return {
      id: stableId("project", relativePath),
      name: packageName ?? (relativePath === "." ? path.basename(root) : path.basename(relativePath)),
      path: relativePath,
      absolutePath,
      kind: projectKind(relativePath, frameworks),
      packageName,
      packageManager: packageManager(absolutePath, root),
      frameworks,
      manifest
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function owningProject(file: string, projects: readonly ProjectDescriptor[]): ProjectDescriptor {
  return [...projects]
    .filter((project) => file === project.absolutePath || file.startsWith(`${project.absolutePath}${path.sep}`))
    .sort((left, right) => right.absolutePath.length - left.absolutePath.length)[0] ?? projects[0]!;
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

function propertyName(node: ts.PropertyName | ts.BindingName | undefined, sourceFile: ts.SourceFile): string {
  if (!node) return "anonymous";
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  return node.getText(sourceFile).replaceAll(/["']/g, "");
}

function enclosingClassName(node: ts.Node): string | null {
  let parent = node.parent;
  while (parent) {
    if (ts.isClassDeclaration(parent) || ts.isClassExpression(parent)) return parent.name?.text ?? "anonymous-class";
    parent = parent.parent;
  }
  return null;
}

function callableName(node: CallableNode, sourceFile: ts.SourceFile): string {
  if (ts.isFunctionDeclaration(node)) return node.name?.text ?? "anonymous";
  if (ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    const name = ts.isConstructorDeclaration(node) ? "constructor" : propertyName(node.name, sourceFile);
    const owner = enclosingClassName(node);
    return owner ? `${owner}.${name}` : name;
  }
  if (ts.isVariableDeclaration(node.parent)) return propertyName(node.parent.name, sourceFile);
  if (ts.isPropertyAssignment(node.parent)) return propertyName(node.parent.name, sourceFile);
  if (ts.isBinaryExpression(node.parent)) return node.parent.left.getText(sourceFile);
  if (ts.isCallExpression(node.parent)) {
    const expression = node.parent.expression.getText(sourceFile);
    const method = ts.isPropertyAccessExpression(node.parent.expression) ? node.parent.expression.name.text.toUpperCase() : expression;
    const routePath = stringValue(node.parent.arguments[0]);
    if ((HTTP_METHODS.has(method.toLowerCase()) || method === "USE") && routePath) return `${method} ${routePath} handler`;
    return `${expression} callback`;
  }
  return `${path.basename(sourceFile.fileName)}:${lineOf(sourceFile, node.getStart(sourceFile))} callback`;
}

function isCallable(node: ts.Node): node is CallableNode {
  return ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function callName(expression: ts.LeftHandSideExpression, sourceFile: ts.SourceFile): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression)) return expression.argumentExpression?.getText(sourceFile) ?? null;
  return null;
}

function isTestCall(node: ts.Node, sourceFile: ts.SourceFile): node is ts.CallExpression {
  return ts.isCallExpression(node) && /^(test|it)(\.(only|skip|todo))?$/.test(node.expression.getText(sourceFile));
}

function testTitle(node: ts.CallExpression): string {
  const first = node.arguments[0];
  if (!first) return "unnamed test";
  if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) return first.text;
  return first.getText().slice(0, 80);
}

function resolveRelativeImport(sourceFile: string, specifier: string, knownFiles: ReadonlySet<string>, extensions: readonly string[]): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(sourceFile), specifier);
  const candidates = [base, ...extensions.map((extension) => `${base}${extension}`), ...extensions.map((extension) => path.join(base, `index${extension}`))];
  return candidates.find((candidate) => knownFiles.has(path.resolve(candidate))) ?? null;
}

function stringValue(node: ts.Expression | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function expressionName(node: ts.Expression, sourceFile: ts.SourceFile): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return callableName(node, sourceFile);
  return null;
}

function callableSignature(node: CallableNode, sourceFile: ts.SourceFile): {
  parameters: string[];
  parameterNames: string[];
  returns: string | null;
  typeReferences: string[];
} {
  const parameters = node.parameters.map((parameter) => parameter.getText(sourceFile));
  const parameterNames = node.parameters.map((parameter) => propertyName(parameter.name, sourceFile));
  const returns = "type" in node && node.type ? node.type.getText(sourceFile) : null;
  const typeText = [...node.parameters.map((parameter) => parameter.type?.getText(sourceFile) ?? ""), returns ?? ""].join(" ");
  const typeReferences = [...new Set(typeText.match(/\b[A-Z][A-Za-z0-9_$]*\b/g) ?? [])];
  return { parameters, parameterNames, returns, typeReferences };
}

function dataModel(node: ts.Node, sourceFile: ts.SourceFile): { name: string; modelKind: string; fields: string[]; definition: string } | null {
  if (ts.isInterfaceDeclaration(node)) return {
    name: node.name.text,
    modelKind: "interface",
    fields: node.members.map((member) => member.getText(sourceFile).replace(/\s+/g, " ").slice(0, 120)),
    definition: node.getText(sourceFile).replace(/\s+/g, " ").slice(0, 500)
  };
  if (ts.isTypeAliasDeclaration(node)) return {
    name: node.name.text,
    modelKind: "type",
    fields: ts.isTypeLiteralNode(node.type) ? node.type.members.map((member) => member.getText(sourceFile).replace(/\s+/g, " ").slice(0, 120)) : [],
    definition: node.type.getText(sourceFile).replace(/\s+/g, " ").slice(0, 500)
  };
  if (ts.isEnumDeclaration(node)) return {
    name: node.name.text,
    modelKind: "enum",
    fields: node.members.map((member) => member.name.getText(sourceFile)),
    definition: node.getText(sourceFile).replace(/\s+/g, " ").slice(0, 500)
  };
  if (ts.isClassDeclaration(node) && node.name) {
    const fields = node.members.filter(ts.isPropertyDeclaration).map((member) => member.getText(sourceFile).replace(/\s+/g, " ").slice(0, 120));
    if (fields.length > 0) return { name: node.name.text, modelKind: "class", fields, definition: node.getText(sourceFile).replace(/\s+/g, " ").slice(0, 500) };
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
    const initializer = node.initializer.getText(sourceFile);
    if (/(?:\bz\.object\s*\(|\bnew\s+(?:mongoose\.)?Schema\s*\(|\bSchema\s*\(|\bcreateSchema\s*\()/i.test(initializer)) {
      return { name: node.name.text, modelKind: "schema", fields: [], definition: initializer.replace(/\s+/g, " ").slice(0, 500) };
    }
  }
  return null;
}

function expressRoute(node: ts.CallExpression, sourceFile: ts.SourceFile): Omit<RouteReference, "node" | "projectId" | "file" | "line"> | null {
  if (!ts.isPropertyAccessExpression(node.expression)) return null;
  const method = node.expression.name.text.toLowerCase();
  if (!HTTP_METHODS.has(method) && method !== "use") return null;
  const receiver = node.expression.expression.getText(sourceFile);
  if (!/(?:^|\.)(?:app|api|router|route|server)$/i.test(receiver)) return null;
  const routePath = stringValue(node.arguments[0]);
  if (!routePath && method !== "use") return null;
  const handlerStart = routePath ? 1 : 0;
  const handlerNames = node.arguments.slice(handlerStart).map((argument) => expressionName(argument, sourceFile)).filter((name): name is string => Boolean(name));
  return {
    kind: receiver.split(".").at(-1)?.toLowerCase() === "api" ? "client" : method === "use" ? "middleware" : "http",
    method: method.toUpperCase(),
    path: routePath ?? "*",
    handlerNames,
    confidence: receiver.split(".").at(-1)?.toLowerCase() === "api" ? "medium" : routePath ? "high" : "medium",
    evidence: receiver.split(".").at(-1)?.toLowerCase() === "api"
      ? `${receiver}.${method}(...) is a static HTTP client endpoint reference`
      : `${receiver}.${method}(...) is a server route in the TypeScript syntax tree`
  };
}

function reactRoute(node: ts.JsxOpeningLikeElement, sourceFile: ts.SourceFile): Omit<RouteReference, "node" | "projectId" | "file" | "line"> | null {
  if (node.tagName.getText(sourceFile).split(".").at(-1) !== "Route") return null;
  const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
  const pathAttribute = attributes.find((attribute) => attribute.name.getText(sourceFile) === "path");
  let routePath = "*";
  if (pathAttribute?.initializer && ts.isStringLiteral(pathAttribute.initializer)) routePath = pathAttribute.initializer.text;
  const elementAttribute = attributes.find((attribute) => attribute.name.getText(sourceFile) === "element" || attribute.name.getText(sourceFile) === "Component");
  const handlerNames: string[] = [];
  if (elementAttribute?.initializer) {
    const text = elementAttribute.initializer.getText(sourceFile);
    const match = text.match(/<\s*([A-Z][\w.]*)|\{\s*([A-Z][\w.]*)\s*\}/);
    const handler = match?.[1] ?? match?.[2];
    if (handler) handlerNames.push(handler.split(".").at(-1)!);
  }
  return {
    kind: "page",
    method: "PAGE",
    path: routePath,
    handlerNames,
    confidence: pathAttribute ? "high" : "medium",
    evidence: "React Router <Route> element in the TSX syntax tree"
  };
}

function addEdge(edges: GraphEdge[], seen: Set<string>, source: string | undefined, target: string | undefined, kind: GraphEdge["kind"], data: Record<string, unknown> = {}): void {
  if (!source || !target || source === target) return;
  const key = `${source}\u0000${target}\u0000${kind}`;
  if (seen.has(key)) return;
  seen.add(key);
  edges.push({ id: stableId("edge", key), source, target, kind, data });
}

export function scanProject(root: string): RepositoryGraph {
  const config = readConfig(root);
  const absoluteFiles = collectFiles(root, config);
  const projects = discoverProjects(root, absoluteFiles, config);
  const knownFiles = new Set(absoluteFiles.map((file) => path.resolve(file)));
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const edgeKeys = new Set<string>();
  const calls: CallReference[] = [];
  const imports: ImportReference[] = [];
  const routes: RouteReference[] = [];
  const callableByName = new Map<string, GraphNode[]>();
  const dataByName = new Map<string, GraphNode[]>();
  const fileIds = new Map<string, string>();
  const projectByFile = new Map<string, ProjectDescriptor>();

  for (const project of projects) {
    nodes.push({
      id: project.id, kind: "project", label: project.name, file: project.path, line: 1, start: 0, end: 0,
      data: { path: project.path, projectId: project.id, projectKind: project.kind, packageName: project.packageName, frameworks: project.frameworks }
    });
  }
  const repositoryProject = projects.find((project) => project.path === ".");
  for (const project of projects) {
    if (project.path !== ".") addEdge(edges, edgeKeys, repositoryProject?.id, project.id, "contains", {
      confidence: "high",
      inference: "Nested project boundary"
    });
  }

  for (const absoluteFile of absoluteFiles) {
    const relativeFile = toProjectPath(root, absoluteFile);
    const fileId = stableId("file", relativeFile);
    const project = owningProject(absoluteFile, projects);
    fileIds.set(path.resolve(absoluteFile), fileId);
    projectByFile.set(path.resolve(absoluteFile), project);
    nodes.push({
      id: fileId, kind: "file", label: path.basename(relativeFile), file: relativeFile, line: 1, start: 0,
      end: fs.statSync(absoluteFile).size, data: { path: relativeFile, projectId: project.id }
    });
    addEdge(edges, edgeKeys, project.id, fileId, "contains", { confidence: "high", inference: "File is inside project boundary" });
  }

  for (const absoluteFile of absoluteFiles) {
    const relativeFile = toProjectPath(root, absoluteFile);
    const fileId = fileIds.get(path.resolve(absoluteFile))!;
    const project = projectByFile.get(path.resolve(absoluteFile))!;
    const sourceText = fs.readFileSync(absoluteFile, "utf8");
    const sourceFile = ts.createSourceFile(absoluteFile, sourceText, ts.ScriptTarget.Latest, true, scriptKind(absoluteFile));

    function addImport(specifier: string): void {
      const target = resolveRelativeImport(absoluteFile, specifier, knownFiles, config.sourceExtensions);
      const targetId = target ? fileIds.get(path.resolve(target)) : undefined;
      const targetProject = target ? projectByFile.get(path.resolve(target)) : undefined;
      if (targetId && targetProject) imports.push({ source: fileId, target: targetId, sourceProjectId: project.id, targetProjectId: targetProject.id });
    }

    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) addImport(statement.moduleSpecifier.text);
      if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) addImport(statement.moduleSpecifier.text);
    }

    function registerCallable(node: ts.Node, kind: NodeKind = "function", labelOverride?: string): GraphNode {
      const name = labelOverride ?? (isCallable(node) ? callableName(node, sourceFile) : "anonymous");
      const start = node.getStart(sourceFile);
      const id = stableId(kind, relativeFile, String(start), name);
      const signature = isCallable(node) ? callableSignature(node, sourceFile) : { parameters: [], parameterNames: [], returns: null, typeReferences: [] };
      const item: GraphNode = {
        id, kind, label: name, file: relativeFile, line: lineOf(sourceFile, start), start, end: node.end,
        data: {
          name,
          displayPath: `${relativeFile}:${lineOf(sourceFile, start)}`,
          projectId: project.id,
          parameters: signature.parameters,
          parameterNames: signature.parameterNames,
          returns: signature.returns,
          typeReferences: signature.typeReferences,
          async: isCallable(node) && Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword))
        }
      };
      nodes.push(item);
      addEdge(edges, edgeKeys, fileId, id, "contains", { confidence: "high", inference: "Declared in file" });
      const simple = name.split(".").at(-1) ?? name;
      if (!callableByName.has(simple)) callableByName.set(simple, []);
      callableByName.get(simple)!.push(item);
      return item;
    }

    function registerDataModel(syntaxNode: ts.Node, model: NonNullable<ReturnType<typeof dataModel>>): GraphNode {
      const start = syntaxNode.getStart(sourceFile);
      const id = stableId("data", relativeFile, String(start), model.name);
      const item: GraphNode = {
        id,
        kind: "data",
        label: model.name,
        file: relativeFile,
        line: lineOf(sourceFile, start),
        start,
        end: syntaxNode.end,
        data: { ...model, projectId: project.id, displayPath: `${relativeFile}:${lineOf(sourceFile, start)}` }
      };
      nodes.push(item);
      addEdge(edges, edgeKeys, fileId, id, "contains", { confidence: "high", inference: "Data model declared in file" });
      if (!dataByName.has(model.name)) dataByName.set(model.name, []);
      dataByName.get(model.name)!.push(item);
      return item;
    }

    function registerRoute(route: Omit<RouteReference, "node" | "projectId" | "file" | "line">, syntaxNode: ts.Node): void {
      const start = syntaxNode.getStart(sourceFile);
      const label = route.kind === "page" ? route.path : `${route.method} ${route.path}`;
      const id = stableId("route", relativeFile, String(start), label);
      const routeNode: GraphNode = {
        id, kind: "route", label, file: relativeFile, line: lineOf(sourceFile, start), start, end: syntaxNode.end,
        data: { projectId: project.id, routeKind: route.kind, method: route.method, path: route.path, handlerNames: route.handlerNames, confidence: route.confidence, inference: route.evidence }
      };
      nodes.push(routeNode);
      addEdge(edges, edgeKeys, project.id, id, "contains", { confidence: "high", inference: "Route belongs to project" });
      addEdge(edges, edgeKeys, fileId, id, "contains", { confidence: "high", inference: "Declared in file" });
      routes.push({ ...route, node: routeNode, projectId: project.id, file: relativeFile, line: lineOf(sourceFile, start) });
    }

    function visit(node: ts.Node, currentCallable: GraphNode | null = null): void {
      const model = dataModel(node, sourceFile);
      if (model) registerDataModel(node, model);
      if (isTestCall(node, sourceFile)) {
        const callback = node.arguments.find((argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument));
        const testNode = registerCallable(callback ?? node, "test", testTitle(node));
        if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) visit(callback.body, testNode);
        return;
      }
      if (isCallable(node)) {
        const callable = registerCallable(node);
        if (node.body) visit(node.body, callable);
        return;
      }
      if (ts.isCallExpression(node)) {
        const route = expressRoute(node, sourceFile);
        if (route) {
          const contextualRoute = route.kind === "client" && currentCallable
            ? { ...route, handlerNames: [...new Set([...route.handlerNames, currentCallable.label])] }
            : route;
          registerRoute(contextualRoute, node);
        }
        const name = callName(node.expression, sourceFile);
        if (currentCallable && name && !["test", "it", "describe"].includes(name)) calls.push({
          source: currentCallable,
          name,
          file: relativeFile,
          arguments: node.arguments.map((argument) => argument.getText(sourceFile).replace(/\s+/g, " ").slice(0, 160)),
          expression: node.expression.getText(sourceFile).slice(0, 160)
        });
        if (ts.isIdentifier(node.expression) && node.expression.text === "require" && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) addImport(node.arguments[0].text);
      }
      if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
        const route = reactRoute(node, sourceFile);
        if (route) registerRoute(route, node);
      }
      ts.forEachChild(node, (child) => visit(child, currentCallable));
    }
    visit(sourceFile);
  }

  for (const item of imports) addEdge(edges, edgeKeys, item.source, item.target, "imports", { confidence: "high", inference: "Explicit relative module import" });

  for (const call of calls) {
    const candidates = callableByName.get(call.name) ?? [];
    const sameFile = candidates.find((candidate) => candidate.file === call.file);
    const target = sameFile ?? (candidates.length === 1 ? candidates[0] : null);
    if (target) addEdge(edges, edgeKeys, call.source.id, target.id, "calls", {
      confidence: sameFile ? "high" : "medium",
      inference: sameFile ? "Same-file symbol call" : "Unique matching callable name across repository",
      expression: call.expression,
      arguments: call.arguments
    });
  }

  for (const callable of nodes.filter((node) => node.kind === "function" || node.kind === "test")) {
    const references = Array.isArray(callable.data.typeReferences) ? callable.data.typeReferences.filter((item): item is string => typeof item === "string") : [];
    for (const reference of references) {
      const candidates = dataByName.get(reference) ?? [];
      const sameFile = candidates.find((candidate) => candidate.file === callable.file);
      const target = sameFile ?? (candidates.length === 1 ? candidates[0] : null);
      if (target) addEdge(edges, edgeKeys, callable.id, target.id, "uses-data", {
        confidence: sameFile ? "high" : "medium",
        inference: sameFile ? "Function signature references a data model in the same file" : "Function signature references a uniquely named data model"
      });
    }
  }

  const routeDefinitions: RouteDefinition[] = routes.map((route) => {
    const handlerNodes = route.handlerNames.flatMap((name) => callableByName.get(name.split(".").at(-1) ?? name) ?? []);
    const preferred = handlerNodes.filter((node) => node.file === route.file);
    const selected = preferred.length > 0 ? preferred : handlerNodes.length === 1 ? handlerNodes : [];
    for (const handler of selected) addEdge(edges, edgeKeys, route.node.id, handler.id, "handles", {
      confidence: handler.file === route.file ? "high" : "medium",
      inference: handler.file === route.file ? "Handler symbol declared in route file" : "Unique matching handler symbol"
    });
    return {
      id: route.node.id, projectId: route.projectId, kind: route.kind, method: route.method, path: route.path,
      file: route.file, line: route.line, handlerNames: route.handlerNames, handlerNodeIds: selected.map((node) => node.id),
      confidence: route.confidence, evidence: route.evidence
    };
  });

  for (const clientRoute of routeDefinitions.filter((route) => route.kind === "client")) {
    const providers = routeDefinitions.filter((route) => route.kind === "http" && route.method === clientRoute.method && route.path === clientRoute.path);
    for (const provider of providers) addEdge(edges, edgeKeys, clientRoute.id, provider.id, "requests", {
      confidence: "medium",
      inference: "Client and server share the same static HTTP method and path"
    });
  }

  const relationshipCounts = new Map<string, number>();
  for (const item of imports) {
    if (item.sourceProjectId === item.targetProjectId) continue;
    const key = `${item.sourceProjectId}\u0000${item.targetProjectId}`;
    relationshipCounts.set(key, (relationshipCounts.get(key) ?? 0) + 1);
  }
  const relationships: ProjectRelationship[] = [...relationshipCounts].map(([key, count]) => {
    const [sourceProjectId, targetProjectId] = key.split("\u0000") as [string, string];
    addEdge(edges, edgeKeys, sourceProjectId, targetProjectId, "depends-on", { count, confidence: "high", inference: `${count} explicit relative import${count === 1 ? "" : "s"}` });
    return { id: stableId("project-relationship", key), sourceProjectId, targetProjectId, kind: "imports", count, confidence: "high" };
  });

  const summaries: ProjectSummary[] = projects.map((project) => {
    const directlyOwned = nodes.filter((node) => node.data.projectId === project.id && node.id !== project.id);
    const owned = project.path === "." && projects.length > 1
      ? nodes.filter((node) => !["project"].includes(node.kind))
      : directlyOwned;
    const entryNodeIds = directlyOwned.filter((node) => node.kind === "file" && /(?:^|\/)(?:index|main|server|app)\.[cm]?[jt]sx?$/.test(node.file)).map((node) => node.id).slice(0, 8);
    return {
      id: project.id, name: project.name, path: project.path, kind: project.kind, packageName: project.packageName,
      packageManager: project.packageManager, frameworks: project.frameworks, entryNodeIds,
      stats: {
        files: owned.filter((node) => node.kind === "file").length,
        functions: owned.filter((node) => node.kind === "function").length,
        tests: owned.filter((node) => node.kind === "test").length,
        routes: owned.filter((node) => node.kind === "route").length,
        dataModels: owned.filter((node) => node.kind === "data").length
      }
    };
  });

  const graph: RepositoryGraph = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    root,
    nodes,
    edges,
    architecture: { projects: summaries, routes: routeDefinitions, relationships },
    stats: {
      files: nodes.filter((node) => node.kind === "file").length,
      functions: nodes.filter((node) => node.kind === "function").length,
      tests: nodes.filter((node) => node.kind === "test").length,
      edges: edges.length,
      projects: projects.length,
      routes: routeDefinitions.length,
      dataModels: nodes.filter((node) => node.kind === "data").length
    }
  };
  writeGraph(root, graph);
  return graph;
}
