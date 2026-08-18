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

        const filename = (state.filename as string) ?? "unknown";
        const fn = path.getFunctionParent();
        const fnName =
          fn && t.isFunctionDeclaration(fn.node) && fn.node.id ? fn.node.id.name : "<anonymous>";

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
      },
    },
  };
}
