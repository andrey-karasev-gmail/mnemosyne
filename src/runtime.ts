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
  | "return";

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
  private frames: Frame[] = [{ fnName: "<module>", vars: new Map() }];
  private lastId: number | undefined = undefined;

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
    this.frames.push({ fnName, vars: new Map() });
  }

  exitFrame(): void {
    this.frames.pop();
  }

  /** Register a function parameter as a leaf input node. */
  param(name: string, value: unknown, loc?: Loc): unknown {
    const id = this.addNode({ kind: "input", label: name, scope: "param", inputs: [], value, loc });
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
    this.frames = [{ fnName: "<module>", vars: new Map() }];
    this.lastId = undefined;
  }
}

/** The singleton tape instance the transpiled code calls into as the free identifier `__t`. */
export const __t = new Tape();
