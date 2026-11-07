/**
 * Mnemosyne Babel plugin — pure AST-in / AST-out.
 *
 * Rewrites native operators, calls, bindings, and returns into calls against a
 * free identifier `__t` (the runtime tape, see src/runtime.ts). This file has
 * zero knowledge of how the tape stores nodes; it only builds `__t.op(...)` /
 * `__t.call(...)` / `__t.bind(...)` / `__t.param(...)` / `__t.ret(...)` /
 * `__t.output(...)` / `__t.envVar(...)` call expressions carrying `{ name,
 * scope, loc }` metadata read from `path.scope` and `node.loc`.
 *
 * Guarding against re-processing our own generated code: every replacement
 * only swaps out a *sub*-path (`init`, `right`, `argument`, a property
 * `value`) rather than the enclosing declarator/assignment/return itself, so
 * that node is never re-visited under its original visitor. The one node type
 * we DO synthesize that shares a visitor with hand-written source is
 * CallExpression (every `__t.*` call is itself a CallExpression) — guarded by
 * `isTapeCall()` below.
 */
import type { NodePath, PluginObj } from "@babel/core";
import * as t from "@babel/types";
import { isRelativeSpecifier, resolveLocalModule } from "./resolve-module";

const TAPE_ID = "__t";

function isTapeCall(node: t.Node | null | undefined): boolean {
  if (!node || !t.isCallExpression(node)) return false;
  const callee = node.callee;
  return t.isMemberExpression(callee) && t.isIdentifier(callee.object) && callee.object.name === TAPE_ID;
}

function tapeMember(name: string): t.MemberExpression {
  return t.memberExpression(t.identifier(TAPE_ID), t.identifier(name));
}

function tapeCall(name: string, args: (t.Expression | t.SpreadElement)[]): t.CallExpression {
  return t.callExpression(tapeMember(name), args);
}

function locNode(loc: t.SourceLocation | null | undefined, filename: string): t.Expression {
  return t.valueToNode({
    file: filename,
    line: loc?.start.line ?? 0,
    column: loc?.start.column ?? 0,
  });
}

type OperandDesc = { kind: "ident" | "literal" | "expr"; name?: string };

function describeOperand(node: t.Node): OperandDesc {
  if (t.isIdentifier(node)) return { kind: "ident", name: node.name };
  if (t.isNumericLiteral(node) || t.isStringLiteral(node) || t.isBooleanLiteral(node) || t.isNullLiteral(node)) {
    return { kind: "literal" };
  }
  return { kind: "expr" };
}

function operandMetaNode(desc: OperandDesc): t.Expression {
  return t.valueToNode(desc.name !== undefined ? { kind: desc.kind, name: desc.name } : { kind: desc.kind });
}

function isSimpleReceiver(node: t.Node): boolean {
  return t.isIdentifier(node) || t.isThisExpression(node);
}

/** `export default function() {}` / `export default class {}` (no name) as a plain expression. */
function anonymousDefaultToExpression(decl: t.Expression | t.Declaration): t.Expression {
  if (t.isFunctionDeclaration(decl)) {
    return t.functionExpression(null, decl.params, decl.body, decl.generator, decl.async);
  }
  if (t.isClassDeclaration(decl)) {
    return t.classExpression(null, decl.superClass, decl.body, decl.decorators);
  }
  return decl as t.Expression;
}

/** module-scope (no enclosing function) vs. function-local. */
function isProgramScope(path: NodePath): boolean {
  return !path.scope.getFunctionParent();
}

type ScopeKind = "local" | "global" | "param" | "temp" | "const";

function scopeKindFor(path: NodePath, declarationKind: "const" | "let" | "var" | undefined): ScopeKind {
  const topLevel = isProgramScope(path);
  if (declarationKind === "const") return topLevel ? "const" : "local";
  return topLevel ? "global" : "local";
}

export default function mnemosynePlugin(): PluginObj {
  return {
    name: "mnemosyne-transform",

    visitor: {
      // process.env.NAME -> __t.envVar('NAME', process.env.NAME, loc)
      MemberExpression(path, state) {
        const node = path.node;
        if (node.computed) return;
        if (!t.isMemberExpression(node.object)) return;
        const inner = node.object;
        if (inner.computed) return;
        if (!t.isIdentifier(inner.object) || inner.object.name !== "process") return;
        if (!t.isIdentifier(inner.property) || inner.property.name !== "env") return;
        if (!t.isIdentifier(node.property)) return;

        const filename = (state.filename as string) ?? "unknown";
        const envName = node.property.name;
        path.replaceWith(
          tapeCall("envVar", [t.stringLiteral(envName), t.cloneNode(node), locNode(node.loc, filename)]),
        );
        path.skip();
      },

      // `import { a, b as c } from "./mod"` / `import Default from "./mod"` — rewritten as
      // plain CommonJS `require()` for a shared value, plus one `__t.importBinding(...)` per
      // named/default binding so cross-file provenance attaches to the exporting module's
      // real node instead of an opaque leaf. Only relative (same-repo) specifiers get that
      // treatment; bare specifiers (node_modules) stay opaque, same as any other untraced call.
      ImportDeclaration(path, state) {
        const node = path.node;
        if (node.importKind === "type") {
          path.remove();
          return;
        }
        if (node.specifiers.some((s) => t.isImportNamespaceSpecifier(s))) {
          throw path.buildCodeFrameError("mnemosyne: namespace imports (\"import * as x\") are not supported yet.");
        }

        const filename = (state.filename as string) ?? "unknown";
        const specifier = node.source.value;
        const requireCall = t.callExpression(t.identifier("require"), [t.stringLiteral(specifier)]);

        if (node.specifiers.length === 0) {
          path.replaceWith(t.expressionStatement(requireCall)); // side-effect-only import
          return;
        }

        const isLocal = isRelativeSpecifier(specifier);
        const modulePath = isLocal ? resolveLocalModule(filename, specifier) : specifier;
        const moduleTempId = path.scope.generateUidIdentifier("mod");

        const statements: t.Statement[] = [
          t.variableDeclaration("const", [t.variableDeclarator(moduleTempId, requireCall)]),
        ];

        for (const spec of node.specifiers) {
          let localName: string;
          let exportName: string;
          if (t.isImportDefaultSpecifier(spec)) {
            localName = spec.local.name;
            exportName = "default";
          } else if (t.isImportSpecifier(spec)) {
            localName = spec.local.name;
            exportName = t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value;
          } else {
            continue; // unreachable: namespace specifiers already rejected above
          }

          const accessedValue = t.memberExpression(t.cloneNode(moduleTempId), t.identifier(exportName));

          if (!isLocal) {
            // Opaque dependency: no origin module to attach an edge to.
            statements.push(
              t.variableDeclaration("const", [t.variableDeclarator(t.identifier(localName), accessedValue)]),
            );
            continue;
          }

          const meta = t.objectExpression([
            t.objectProperty(t.identifier("modulePath"), t.stringLiteral(modulePath)),
            t.objectProperty(t.identifier("exportName"), t.stringLiteral(exportName)),
            t.objectProperty(t.identifier("loc"), locNode(node.loc, filename)),
          ]);
          statements.push(
            t.variableDeclaration("const", [
              t.variableDeclarator(
                t.identifier(localName),
                tapeCall("importBinding", [t.stringLiteral(localName), accessedValue, meta]),
              ),
            ]),
          );
        }

        path.replaceWithMultiple(statements);
      },

      // `export const x = ...` / `export function foo() {}` — keep the declaration (still
      // instrumented normally by the visitors above) and append `exports.x = x;` so importers
      // can see it, PLUS a `__t.recordExport(exportedName, localName)` so `registerModule()`
      // (runtime.ts) can key the exporting module's node lookup by the *external* export name
      // rather than assuming it always matches the local variable name (it doesn't for
      // `export { a as b }` or `export default`, handled below). `export { a, b as c }` (no
      // attached declaration) becomes just the `exports.*` assignments + recordExport calls.
      // Re-exports (`export ... from "./other"`) are out of scope.
      ExportNamedDeclaration(path) {
        const node = path.node;
        if (node.source) {
          throw path.buildCodeFrameError("mnemosyne: re-exports (\"export ... from\") are not supported yet.");
        }

        if (node.declaration) {
          const decl = node.declaration;
          const names: string[] = [];
          if (t.isVariableDeclaration(decl)) {
            for (const d of decl.declarations) {
              if (t.isIdentifier(d.id)) names.push(d.id.name);
            }
          } else if ((t.isFunctionDeclaration(decl) || t.isClassDeclaration(decl)) && decl.id) {
            names.push(decl.id.name);
          }
          const exportStmts = names.flatMap((name) => [
            t.expressionStatement(
              t.assignmentExpression(
                "=",
                t.memberExpression(t.identifier("exports"), t.identifier(name)),
                t.identifier(name),
              ),
            ),
            t.expressionStatement(tapeCall("recordExport", [t.stringLiteral(name), t.stringLiteral(name)])),
          ]);
          path.replaceWithMultiple([decl, ...exportStmts]);
          return;
        }

        const exportStmts = node.specifiers.flatMap((spec) => {
          if (!t.isExportSpecifier(spec)) {
            throw path.buildCodeFrameError("mnemosyne: this export form is not supported yet.");
          }
          const localName = spec.local.name;
          const exportedName = t.isIdentifier(spec.exported) ? spec.exported.name : spec.exported.value;
          return [
            t.expressionStatement(
              t.assignmentExpression(
                "=",
                t.memberExpression(t.identifier("exports"), t.identifier(exportedName)),
                t.identifier(localName),
              ),
            ),
            t.expressionStatement(tapeCall("recordExport", [t.stringLiteral(exportedName), t.stringLiteral(localName)])),
          ];
        });
        path.replaceWithMultiple(exportStmts);
      },

      // `export default <expr>` / `export default function foo() {}` -> `exports.default = ...`
      // (+ `recordExport("default", localName)`). A *named* function/class declaration already
      // has a real local binding to record against. An anonymous declaration or a bare
      // expression (`export default 42`, `export default () => ...`) has none, so it's bound to
      // a synthesized `const` first — that `VariableDeclarator` is instrumented normally by the
      // visitor above, giving it a real node to record, instead of leaving the export
      // unresolvable (see runtime.ts's `recordExport`/`registerModule`).
      ExportDefaultDeclaration(path) {
        const node = path.node;
        const decl = node.declaration;
        if ((t.isFunctionDeclaration(decl) || t.isClassDeclaration(decl)) && decl.id) {
          path.replaceWithMultiple([
            decl,
            t.expressionStatement(
              t.assignmentExpression(
                "=",
                t.memberExpression(t.identifier("exports"), t.identifier("default")),
                t.identifier(decl.id.name),
              ),
            ),
            t.expressionStatement(tapeCall("recordExport", [t.stringLiteral("default"), t.stringLiteral(decl.id.name)])),
          ]);
          return;
        }

        const tempId = path.scope.generateUidIdentifier("default");
        path.replaceWithMultiple([
          t.variableDeclaration("const", [
            t.variableDeclarator(tempId, anonymousDefaultToExpression(decl)),
          ]),
          t.expressionStatement(
            t.assignmentExpression(
              "=",
              t.memberExpression(t.identifier("exports"), t.identifier("default")),
              t.cloneNode(tempId),
            ),
          ),
          t.expressionStatement(tapeCall("recordExport", [t.stringLiteral("default"), t.stringLiteral(tempId.name)])),
        ]);
      },

      BinaryExpression(path, state) {
        const node = path.node;
        const operator = node.operator;
        const SUPPORTED = ["+", "-", "*", "/", "<", ">", "<=", ">=", "===", "!=="];
        if (!SUPPORTED.includes(operator)) return;
        if (!t.isExpression(node.left)) return; // excludes PrivateName

        const filename = (state.filename as string) ?? "unknown";
        const lhsDesc = describeOperand(node.left);
        const rhsDesc = describeOperand(node.right);

        const meta = t.objectExpression([
          t.objectProperty(t.identifier("loc"), locNode(node.loc, filename)),
          t.objectProperty(t.identifier("lhs"), operandMetaNode(lhsDesc)),
          t.objectProperty(t.identifier("rhs"), operandMetaNode(rhsDesc)),
        ]);

        path.replaceWith(
          tapeCall("op", [t.stringLiteral(operator), t.cloneNode(node.left), t.cloneNode(node.right), meta]),
        );
        // Do not skip: nested operands (e.g. (a+b)+c) must still be visited/rewritten.
      },

      // Short-circuit `&& || ??`: the left side always runs; the right side must only run
      // (and only get traced) when JS itself would evaluate it. We can't just eagerly
      // compute both sides like BinaryExpression does — that would change behavior (e.g.
      // `a && a.b` with `a` null must never evaluate `a.b`). So the right side is wrapped in
      // a thunk and only invoked by the runtime once it has decided short-circuiting doesn't
      // apply, preserving both semantics and evaluation order.
      LogicalExpression(path, state) {
        const node = path.node;
        const operator = node.operator;
        const filename = (state.filename as string) ?? "unknown";
        const lhsDesc = describeOperand(node.left);
        const rhsDesc = describeOperand(node.right);

        const meta = t.objectExpression([
          t.objectProperty(t.identifier("loc"), locNode(node.loc, filename)),
          t.objectProperty(t.identifier("lhs"), operandMetaNode(lhsDesc)),
          t.objectProperty(t.identifier("rhs"), operandMetaNode(rhsDesc)),
        ]);

        const rightThunk = t.arrowFunctionExpression([], t.cloneNode(node.right));

        path.replaceWith(
          tapeCall("logical", [t.stringLiteral(operator), t.cloneNode(node.left), rightThunk, meta]),
        );
        // Do not skip: node.left/node.right still need their own nested rewriting.
      },

      CallExpression(path, state) {
        const node = path.node;
        if (isTapeCall(node)) return; // don't re-wrap our own emitted calls
        if (node.callee.type === "Import" || t.isSuper(node.callee)) return;
        if (node.arguments.some((a) => t.isSpreadElement(a) || t.isArgumentPlaceholder(a))) return; // deferred (spread)

        const filename = (state.filename as string) ?? "unknown";
        const args = node.arguments as t.Expression[];
        const argMetas = args.map((a) => operandMetaNode(describeOperand(a)));
        const argsArrayNode = t.arrayExpression(args.map((a) => t.cloneNode(a)));

        if (t.isMemberExpression(node.callee) && !node.callee.computed && t.isIdentifier(node.callee.property)) {
          const methodName = node.callee.property.name;
          let receiverExpr: t.Expression = node.callee.object as t.Expression;
          let receiverDesc = describeOperand(receiverExpr);

          if (!isSimpleReceiver(receiverExpr)) {
            // Hoist non-trivial receivers to a temp so we never double-evaluate them.
            const statementPath = path.getStatementParent();
            if (statementPath) {
              const tempId = path.scope.generateUidIdentifier("recv");
              statementPath.insertBefore(
                t.variableDeclaration("const", [t.variableDeclarator(tempId, t.cloneNode(receiverExpr))]),
              );
              receiverExpr = t.cloneNode(tempId);
              receiverDesc = { kind: "expr" };
            }
          }

          const meta = t.objectExpression([
            t.objectProperty(t.identifier("loc"), locNode(node.loc, filename)),
            t.objectProperty(t.identifier("label"), t.stringLiteral(methodName)),
            t.objectProperty(t.identifier("receiverMeta"), operandMetaNode(receiverDesc)),
            t.objectProperty(t.identifier("argMetas"), t.arrayExpression(argMetas)),
          ]);

          path.replaceWith(
            tapeCall("call", [t.cloneNode(receiverExpr), t.stringLiteral(methodName), argsArrayNode, meta]),
          );
          return;
        }

        if (t.isIdentifier(node.callee)) {
          const fnName = node.callee.name;
          const meta = t.objectExpression([
            t.objectProperty(t.identifier("loc"), locNode(node.loc, filename)),
            t.objectProperty(t.identifier("label"), t.stringLiteral(fnName)),
            t.objectProperty(t.identifier("argMetas"), t.arrayExpression(argMetas)),
          ]);
          path.replaceWith(
            tapeCall("call", [t.nullLiteral(), t.cloneNode(node.callee), argsArrayNode, meta]),
          );
          return;
        }
        // Complex/computed callees: out of PoC scope, leave untouched.
      },

      // An async function's tape frame must not remain atop the shared frame
      // stack while it is suspended. awaitValue restores it before the function
      // continuation (or a local catch) runs.
      AwaitExpression(path) {
        const fn = path.getFunctionParent();
        if (!fn || !t.isFunctionDeclaration(fn.node) || !fn.node.id || !fn.node.async) return;
        const argument = path.node.argument;
        path.node.argument = tapeCall("awaitValue", [argument]);
      },

      VariableDeclarator(path, state) {
        const node = path.node;
        if (!t.isIdentifier(node.id) || !node.init) return;
        const initPath = path.get("init") as NodePath<t.Expression>;
        if (isTapeCall(initPath.node)) return;

        const filename = (state.filename as string) ?? "unknown";
        const declKind = (path.parentPath.node as t.VariableDeclaration).kind as "const" | "let" | "var";
        const name = node.id.name;
        const sourceDesc = describeOperand(node.init);
        const scope = scopeKindFor(path, declKind === "var" ? undefined : declKind);

        const meta = t.objectExpression([
          t.objectProperty(t.identifier("scope"), t.stringLiteral(scope)),
          t.objectProperty(t.identifier("loc"), locNode(node.loc, filename)),
          t.objectProperty(t.identifier("source"), operandMetaNode(sourceDesc)),
          t.objectProperty(t.identifier("isDeclaration"), t.booleanLiteral(true)),
        ]);

        initPath.replaceWith(tapeCall("bind", [t.stringLiteral(name), t.cloneNode(node.init), meta]));
      },

      AssignmentExpression(path, state) {
        const node = path.node;
        if (node.operator !== "=" || !t.isIdentifier(node.left)) return;
        if (isTapeCall(node.right)) return; // already ours (e.g. injected param registration)

        const filename = (state.filename as string) ?? "unknown";
        const name = node.left.name;
        const sourceDesc = describeOperand(node.right);
        const scope = scopeKindFor(path, undefined);

        const meta = t.objectExpression([
          t.objectProperty(t.identifier("scope"), t.stringLiteral(scope)),
          t.objectProperty(t.identifier("loc"), locNode(node.loc, filename)),
          t.objectProperty(t.identifier("source"), operandMetaNode(sourceDesc)),
          t.objectProperty(t.identifier("isDeclaration"), t.booleanLiteral(false)),
        ]);

        (path.get("right") as NodePath<t.Expression>).replaceWith(
          tapeCall("bind", [t.stringLiteral(name), t.cloneNode(node.right), meta]),
        );
      },

      ReturnStatement(path, state) {
        const node = path.node;
        if (!node.argument) return;
        if (isTapeCall(node.argument)) return;

        // Only a named `FunctionDeclaration` gets an `enterFrame()` prologue (see the
        // `FunctionDeclaration` visitor below) — `__t.ret()` unconditionally pops a frame, so
        // wrapping a return whose enclosing function never pushed one (an arrow function,
        // function expression, method, or anonymous function — e.g. `export default
        // function () {...}`) would pop a frame that belongs to someone else (the caller, or
        // whatever module happens to be running), corrupting scope resolution for the rest of
        // the run. Leave such returns untouched; the returned value's own evaluation is still
        // traced by the visitors that produced it, only the `return` node itself is skipped.
        const fn = path.getFunctionParent();
        const isTracedFn = !!(fn && t.isFunctionDeclaration(fn.node) && fn.node.id);
        if (!isTracedFn) return;
        const fnName = (fn!.node as t.FunctionDeclaration).id!.name;

        const filename = (state.filename as string) ?? "unknown";

        if (t.isObjectExpression(node.argument)) {
          for (const prop of node.argument.properties) {
            if (!t.isObjectProperty(prop) || prop.computed || !t.isExpression(prop.value)) continue;
            const key = prop.key;
            const attrName = t.isIdentifier(key) ? key.name : t.isStringLiteral(key) ? key.value : undefined;
            if (!attrName) continue;

            const valueDesc = describeOperand(prop.value);
            const meta = t.objectExpression([
              t.objectProperty(t.identifier("loc"), locNode(prop.loc, filename)),
              t.objectProperty(t.identifier("source"), operandMetaNode(valueDesc)),
            ]);
            const original = prop.value;
            prop.value = tapeCall("output", [t.stringLiteral(fnName), t.stringLiteral(attrName), t.cloneNode(original), meta]);
          }

          const retMeta = t.objectExpression([
            t.objectProperty(t.identifier("loc"), locNode(node.loc, filename)),
            t.objectProperty(t.identifier("source"), operandMetaNode({ kind: "expr" })),
          ]);
          (path.get("argument") as NodePath<t.Expression>).replaceWith(
            tapeCall("ret", [t.stringLiteral(fnName), t.cloneNode(node.argument), retMeta]),
          );
          return;
        }

        const sourceDesc = describeOperand(node.argument);
        const meta = t.objectExpression([
          t.objectProperty(t.identifier("loc"), locNode(node.loc, filename)),
          t.objectProperty(t.identifier("source"), operandMetaNode(sourceDesc)),
        ]);
        (path.get("argument") as NodePath<t.Expression>).replaceWith(
          tapeCall("ret", [t.stringLiteral(fnName), t.cloneNode(node.argument), meta]),
        );
      },

      FunctionDeclaration(path, state) {
        const node = path.node;
        if (!node.id || !node.body) return;
        const filename = (state.filename as string) ?? "unknown";
        const fnName = node.id.name;

        const prologue: t.Statement[] = [t.expressionStatement(tapeCall("enterFrame", [t.stringLiteral(fnName)]))];

        for (const param of node.params) {
          if (!t.isIdentifier(param)) continue; // destructuring/defaults/rest: deferred
          const loc = locNode(param.loc, filename);
          prologue.push(
            t.expressionStatement(
              t.assignmentExpression(
                "=",
                t.identifier(param.name),
                tapeCall("param", [t.stringLiteral(param.name), t.identifier(param.name), loc]),
              ),
            ),
          );
        }

        path.get("body").unshiftContainer("body", prologue);

        // Register the function's own name so an `import { fnName }` elsewhere (or any other
        // by-name lookup) resolves to a real node instead of a synthesized ambient leaf.
        path.insertAfter(
          t.expressionStatement(
            tapeCall("declareFunction", [
              t.stringLiteral(fnName),
              t.identifier(fnName),
              t.objectExpression([
                t.objectProperty(t.identifier("scope"), t.stringLiteral(isProgramScope(path) ? "const" : "local")),
                t.objectProperty(t.identifier("loc"), locNode(node.loc, filename)),
              ]),
            ]),
          ),
        );
      },
    },
  };
}
