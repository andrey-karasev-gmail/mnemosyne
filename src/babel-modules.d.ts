/**
 * Local declarations for the two Babel packages compile.ts loads directly.
 * Neither @babel/preset-typescript nor @babel/plugin-transform-modules-commonjs
 * ships its own type declarations (and no @types/babel__* package exists for
 * them), so importing them fails `strict` typechecking with TS7016 without
 * these. Both are consumed purely as Babel PluginItems.
 */
declare module "@babel/preset-typescript" {
  import type { PluginItem } from "@babel/core";
  const preset: PluginItem;
  export default preset;
}

declare module "@babel/plugin-transform-modules-commonjs" {
  import type { PluginItem } from "@babel/core";
  const plugin: PluginItem;
  export default plugin;
}
