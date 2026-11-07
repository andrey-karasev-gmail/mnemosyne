/**
 * Mnemosyne runtime — the `__t` side-channel tape.
 *
 * Values always flow through unchanged: every method here returns exactly the
 * value it was given (or the value produced by actually performing the traced
 * operation), and records a node into an in-memory DAG as a side effect. The
 * transpiler (src/transform.ts) never touches this file's internals; it only
 * emits calls against this public API.
 *
 * Node-identity model (see CLAUDE.md "Conventions"): a value's provenance is
 * resolved either by name (identifiers are looked up in a runtime call-frame
 * stack that mirrors the real JS call stack — params/const/let register on
 * write, reads resolve by walking the stack outward, exactly like lexical
 * scoping), by literal (a fresh leaf node per literal operand), or — for an
 * operand that is itself an unnamed sub-expression — by falling back to "the
 * last node this tape produced" (valid because nested `__t.*` calls fully
 * execute, in evaluation order, before an enclosing call runs).
 */

export interface Loc {
  file: string;
  line: number;
  column: number;
}

export type ScopeKind =
  | "local"
  | "global"
  | "param"
  | "temp"
  | "const"
  | "env"
  | "literal"
  | "output"
  | "return"
  | "import";

export type NodeKind = "input" | "op" | "call" | "bind" | "return" | "output" | "literal";

export interface TapeNode {
  id: number;
  kind: NodeKind;
  op?: string;
  label: string;
  scope: ScopeKind;
  inputs: number[];
  value: unknown;
  loc?: Loc;
  fn?: string;
}

export type OperandKind = "ident" | "literal" | "expr";

export interface OperandMeta {
  name?: string;
  kind: OperandKind;
}

interface Frame {
  fnName: string;
  vars: Map<string, number>;
  /** export name -> local name, populated by `recordExport()` calls that run during this
   * frame's (module's) own execution. Kept per-frame, not on the tape, so a nested import's
   * own recordExport/registerModule cycle can never clobber an outer module's pending
   * exports, however import and export statements happen to be interleaved in source order. */
  exportBindings: Map<string, string>;
}

function newFrame(fnName: string): Frame {
  return { fnName, vars: new Map(), exportBindings: new Map() };
}

function computeOp(operator: string, l: any, r: any): any {
  switch (operator) {
    case "+":
      return l + r;
    case "-":
      return l - r;
    case "*":
      return l * r;
    case "/":
      return l / r;
    case "<":
      return l < r;
    case ">":
      return l > r;
    case "<=":
      return l <= r;
    case ">=":
      return l >= r;
    case "===":
      return l === r;
    case "!==":
      return l !== r;
    default:
      throw new Error(`__t.op: unsupported operator "${operator}"`);
  }
}

export class Tape {
  nodes: TapeNode[] = [];
  private frames: Frame[] = [newFrame("<module>")];
  private lastId: number | undefined = undefined;
  /** Resolved module file path -> (export name -> node id), snapshotted once a module
   * finishes running (see module-loader.ts). Lets an importing module's `importBinding`
   * attach a real ancestry edge instead of falling back to an opaque leaf. */
  private moduleExports = new Map<string, Map<string, number>>();

  private currentFrame(): Frame {
    return this.frames[this.frames.length - 1];
  }

  private addNode(partial: Omit<TapeNode, "id">): number {
    const id = this.nodes.length;
    this.nodes.push({ id, ...partial });
    this.lastId = id;
    return id;
  }

  /** Resolve an operand to the id of the node that produced its value. */
  private resolve(operand: OperandMeta | undefined, value: unknown): number | undefined {
    if (!operand) {
      return this.lastId;
    }
    if (operand.kind === "literal") {
      return this.addNode({ kind: "literal", label: String(value), scope: "literal", inputs: [], value });
    }
    if (operand.kind === "ident" && operand.name) {
      for (let i = this.frames.length - 1; i >= 0; i--) {
        const id = this.frames[i].vars.get(operand.name);
        if (id !== undefined) return id;
      }
      // Referenced before any bind/param call recorded it (e.g. an ambient
      // global never declared in traced source) — synthesize a leaf node.
      return this.addNode({ kind: "input", label: operand.name, scope: "global", inputs: [], value });
    }
    // 'expr': the nested __t.* call that produced this value already ran.
    return this.lastId;
  }

  enterFrame(fnName: string): void {
    this.frames.push(newFrame(fnName));
  }

  /**
   * Detach the current traced function while an await is pending. The JS async
   * function resumes in a later microtask, so leaving its frame on this shared
   * stack would make synchronous work run in the meantime resolve names against
   * the suspended function. Restore the frame before the await continuation
   * executes (including rejection continuations/catches).
   */
  awaitValue<T>(value: T): Promise<Awaited<T>> {
    if (this.frames.length <= 1) return Promise.resolve(value) as Promise<Awaited<T>>;
    const frame = this.frames.pop()!;
    return Promise.resolve(value).then(
      (resolved) => {
        this.frames.push(frame);
        return resolved as Awaited<T>;
      },
      (error: unknown) => {
        this.frames.push(frame);
        throw error;
      },
    );
  }

  exitFrame(): void {
    this.frames.pop();
  }

  /** `export { local as exported }` / `export default local` (see transform.ts): record that
   * `exportName` is currently bound to `localName` in this module, so `registerModule()` can
   * resolve it to a real node id — keyed by the *external* name an importer asks for, which
   * only coincides with the local variable name for a plain `export const x = ...`. */
  recordExport(exportName: string, localName: string): void {
    this.currentFrame().exportBindings.set(exportName, localName);
  }

  /** Snapshot the current (module) frame's exports under `modulePath`, so a future importer
   * of this module can resolve `importBinding`'s `exportName` to a real node id. Only names
   * actually recorded via `recordExport()` are included — and each is looked up by its local
   * name at snapshot time, so `export { a as b }` / `export default` resolve correctly
   * instead of assuming the export name matches the local variable name. */
  registerModule(modulePath: string): void {
    const frame = this.currentFrame();
    const exportMap = new Map<string, number>();
    for (const [exportName, localName] of frame.exportBindings) {
      const id = frame.vars.get(localName);
      if (id !== undefined) exportMap.set(exportName, id);
    }
    this.moduleExports.set(modulePath, exportMap);
  }

  /** `import { name } from "./mod"` (or default): looks up the exporting module's already-
   * recorded node for `exportName` and records a `bind`-like node for `localName` in the
   * importing module's current frame, wired to that node as its input. */
  importBinding(localName: string, value: unknown, meta: { modulePath: string; exportName: string; loc?: Loc }): unknown {
    const sourceId = this.moduleExports.get(meta.modulePath)?.get(meta.exportName);
    const id = this.addNode({
      kind: "bind",
      label: localName,
      scope: "import",
      inputs: sourceId !== undefined ? [sourceId] : [],
      value,
      loc: meta.loc,
    });
    this.currentFrame().vars.set(localName, id);
    return value;
  }

  /** Register a function parameter as a leaf input node. */
  param(name: string, value: unknown, loc?: Loc): unknown {
    const id = this.addNode({ kind: "input", label: name, scope: "param", inputs: [], value, loc });
    this.currentFrame().vars.set(name, id);
    return value;
  }

  /**
   * Register a `function name() {}` declaration by name so other bindings (notably a cross-
   * file `import { name }`) can resolve to a real node instead of a synthesized leaf. Function
   * declarations don't flow through `bind()` (they aren't `VariableDeclarator`/assignment
   * nodes), so this exists to give them the same "named, resolvable" status those get.
   */
  declareFunction(name: string, value: unknown, meta: { scope: ScopeKind; loc?: Loc }): unknown {
    const id = this.addNode({ kind: "bind", label: name, scope: meta.scope, inputs: [], value, loc: meta.loc });
    this.currentFrame().vars.set(name, id);
    return value;
  }

  /** Register a `process.env.NAME` read as a leaf node, capturing its real value. */
  envVar(name: string, value: unknown, loc?: Loc): unknown {
    this.addNode({ kind: "input", label: `process.env.${name}`, scope: "env", inputs: [], value, loc });
    return value;
  }

  /** `const x = ...` / `let x = ...` / simple assignment `x = ...`. */
  bind(
    name: string,
    value: unknown,
    meta: { scope: ScopeKind; loc?: Loc; source?: OperandMeta; isDeclaration: boolean },
  ): unknown {
    const inputId = this.resolve(meta.source, value);
    const id = this.addNode({
      kind: "bind",
      label: name,
      scope: meta.scope,
      inputs: inputId !== undefined ? [inputId] : [],
      value,
      loc: meta.loc,
    });
    if (meta.isDeclaration) {
      this.currentFrame().vars.set(name, id);
    } else {
      for (let i = this.frames.length - 1; i >= 0; i--) {
        if (this.frames[i].vars.has(name)) {
          this.frames[i].vars.set(name, id);
          return value;
        }
      }
      this.currentFrame().vars.set(name, id);
    }
    return value;
  }

  /**
   * Short-circuit `&& || ??`. `left` is already evaluated (JS always evaluates it); `right`
   * is a thunk so it only runs — and only gets traced — when short-circuiting doesn't apply,
   * matching native semantics exactly. The left operand is resolved before invoking the
   * thunk so an 'expr'-kind left operand's `lastId` fallback can't be clobbered by whatever
   * the thunk goes on to evaluate.
   */
  logical(
    operator: "&&" | "||" | "??",
    left: unknown,
    right: () => unknown,
    meta: { loc?: Loc; lhs?: OperandMeta; rhs?: OperandMeta },
  ): unknown {
    const lid = this.resolve(meta.lhs, left);

    const shortCircuits =
      operator === "&&" ? !left : operator === "||" ? !!left : left !== null && left !== undefined;

    if (shortCircuits) {
      const inputs = lid !== undefined ? [lid] : [];
      this.addNode({ kind: "op", op: operator, label: operator, scope: "temp", inputs, value: left, loc: meta.loc });
      return left;
    }

    const rightValue = right();
    const rid = this.resolve(meta.rhs, rightValue);
    const inputs = [lid, rid].filter((x): x is number => x !== undefined);
    this.addNode({ kind: "op", op: operator, label: operator, scope: "temp", inputs, value: rightValue, loc: meta.loc });
    return rightValue;
  }

  /** Binary operator: computes the real result (native ops can't be overloaded) and records it. */
  op(operator: string, left: unknown, right: unknown, meta: { loc?: Loc; lhs?: OperandMeta; rhs?: OperandMeta }): unknown {
    const result = computeOp(operator, left, right);
    const lid = this.resolve(meta.lhs, left);
    const rid = this.resolve(meta.rhs, right);
    const inputs = [lid, rid].filter((x): x is number => x !== undefined);
    this.addNode({ kind: "op", op: operator, label: operator, scope: "temp", inputs, value: result, loc: meta.loc });
    return result;
  }

  /** Method call `recv.name(args)` or plain call `fn(args)` (receiver === null). */
  call(
    receiver: unknown,
    fnOrName: unknown,
    args: unknown[],
    meta: { loc?: Loc; label: string; receiverMeta?: OperandMeta; argMetas?: OperandMeta[] },
  ): unknown {
    // Resolve provenance BEFORE invoking: if fnOrName is a traced user function, invoking
    // it produces many more tape nodes and would clobber the `lastId` fallback that
    // 'expr'-kind (unnamed sub-expression) receiver/args rely on.
    const inputs: number[] = [];
    if (receiver !== null && receiver !== undefined) {
      const rid = this.resolve(meta.receiverMeta, receiver);
      if (rid !== undefined) inputs.push(rid);
    }
    args.forEach((a, i) => {
      const aid = this.resolve(meta.argMetas?.[i], a);
      if (aid !== undefined) inputs.push(aid);
    });

    // If the callee is a traced function, its own enterFrame() has no matching
    // exitFrame() unless it reaches its own `return` (ret() is what pops). A
    // throw skips straight over that, so unwind back to the depth we started
    // at here — otherwise the callee's frame leaks onto the stack forever and
    // corrupts scope resolution for the rest of the run.
    const frameDepthBeforeCall = this.frames.length;
    let result: unknown;
    let opName: string;
    try {
      if (typeof fnOrName === "string") {
        result = (receiver as any)[fnOrName](...args);
        opName = fnOrName;
      } else if (typeof fnOrName === "function") {
        result = fnOrName.apply(receiver, args);
        opName = fnOrName.name || meta.label;
      } else {
        throw new Error("__t.call: second argument must be a method name or a function");
      }
    } catch (err) {
      this.frames.length = frameDepthBeforeCall;
      throw err;
    }

    this.addNode({ kind: "call", op: opName, label: meta.label, scope: "temp", inputs, value: result, loc: meta.loc });
    return result;
  }

  /** A single named attribute of an object literal returned from a traced function. */
  output(fnName: string, attr: string, value: unknown, meta: { loc?: Loc; source?: OperandMeta }): unknown {
    const sid = this.resolve(meta.source, value);
    this.addNode({
      kind: "output",
      label: `${fnName}.${attr}`,
      scope: "output",
      inputs: sid !== undefined ? [sid] : [],
      value,
      loc: meta.loc,
      fn: fnName,
    });
    return value;
  }

  /** `return expr` inside a traced function. Pops the call frame. */
  ret(fnName: string, value: unknown, meta: { loc?: Loc; source?: OperandMeta }): unknown {
    const sid = this.resolve(meta.source, value);
    this.addNode({
      kind: "return",
      label: `${fnName} return`,
      scope: "return",
      inputs: sid !== undefined ? [sid] : [],
      value,
      loc: meta.loc,
      fn: fnName,
    });
    this.exitFrame();
    return value;
  }

  /** Clear the tape and frame stack for a fresh run. */
  reset(): void {
    this.nodes = [];
    this.frames = [newFrame("<module>")];
    this.lastId = undefined;
    this.moduleExports.clear();
  }
}

/** The singleton tape instance the transpiled code calls into as the free identifier `__t`. */
export const __t = new Tape();
