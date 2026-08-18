// Reference Babel config for running Mnemosyne's plugin standalone (e.g. via the
// Babel CLI). The programmatic pipeline (src/run-example.ts) passes the same
// preset/plugin directly to `transformSync` so it does not depend on file-based
// config resolution, but this file documents the equivalent setup.
module.exports = {
  presets: [["@babel/preset-typescript", { onlyRemoveTypeImports: true }]],
  plugins: [require("./src/transform").default],
  filename: "example.ts",
};
