// ESLint flat config with no imports, so it runs without a package.json:  npx eslint@9.39.1 .
// Rules are eslint:recommended's error-catching core plus a few for clarity; globals are listed by hand.
const browser = Object.fromEntries(["window", "document", "navigator", "localStorage", "sessionStorage", "performance",
  "setTimeout", "clearTimeout", "requestAnimationFrame", "getComputedStyle", "matchMedia", "ResizeObserver", "URL", "Blob", "File",
  "Image", "ImageData", "DataTransfer", "DragEvent", "Event", "DOMException", "TextEncoder", "TextDecoder", "Uint8Array",
  "Uint8ClampedArray", "DataView", "alert", "confirm", "prompt", "fetch", "createImageBitmap", "btoa", "self",
  "HTMLInputElement", "CanvasRenderingContext2D", "Element", "KeyboardEvent", "PointerEvent", "Storage", "ZipWriter"].map((g) => [g, "readonly"]));
const node = { require: "readonly", module: "writable", console: "readonly" };

const rules = {
  // eslint:recommended (problems, not style)
  "constructor-super": "error", "for-direction": "error", "getter-return": "error", "no-async-promise-executor": "error",
  "no-case-declarations": "error", "no-class-assign": "error", "no-compare-neg-zero": "error", "no-cond-assign": "error",
  "no-const-assign": "error", "no-constant-binary-expression": "error", "no-constant-condition": ["error", { checkLoops: false }],
  "no-control-regex": "error", "no-debugger": "error", "no-delete-var": "error", "no-dupe-args": "error", "no-dupe-else-if": "error",
  "no-dupe-keys": "error", "no-duplicate-case": "error", "no-empty": ["error", { allowEmptyCatch: true }], "no-empty-character-class": "error",
  "no-empty-pattern": "error", "no-ex-assign": "error", "no-fallthrough": "error", "no-func-assign": "error", "no-global-assign": "error",
  "no-import-assign": "error", "no-inner-declarations": "error", "no-invalid-regexp": "error", "no-irregular-whitespace": "error",
  "no-loss-of-precision": "error", "no-misleading-character-class": "error", "no-new-native-nonconstructor": "error",
  "no-obj-calls": "error", "no-octal": "error", "no-prototype-builtins": "error", "no-redeclare": "error", "no-regex-spaces": "error",
  "no-self-assign": "error", "no-setter-return": "error", "no-shadow-restricted-names": "error", "no-sparse-arrays": "error",
  "no-this-before-super": "error", "no-undef": "error", "no-unexpected-multiline": "error", "no-unreachable": "error",
  "no-unsafe-finally": "error", "no-unsafe-negation": "error", "no-unsafe-optional-chaining": "error", "no-unused-labels": "error",
  "no-unused-private-class-members": "error", "no-unused-vars": ["error", { args: "after-used", caughtErrors: "none" }],
  "no-useless-backreference": "error", "no-useless-catch": "error", "no-useless-escape": "error", "no-with": "error",
  "require-yield": "error", "use-isnan": "error", "valid-typeof": "error",
  // clarity
  "eqeqeq": ["error", "smart"], "no-var": "error", "prefer-const": ["error", { destructuring: "all" }], "no-implicit-globals": "error",
};

module.exports = [
  { ignores: ["vendor/**", ".playwright-cli/**"] },
  { files: ["app.js", "zip.js"], languageOptions: { ecmaVersion: 2022, sourceType: "script", globals: { ...browser, MorphoGeom: "readonly" } }, rules },
  { files: ["geometry.js"], languageOptions: { ecmaVersion: 2022, sourceType: "script", globals: { ...browser, ...node } }, rules },
  { files: ["tests/*.js"], languageOptions: { ecmaVersion: 2022, sourceType: "commonjs", globals: node }, rules },
  // e2e files are one function expression, run in the page's Node context by playwright-cli
  { files: ["tests/e2e/*.js", "docs/media/*.js"], languageOptions: { ecmaVersion: 2022, sourceType: "script", globals: browser }, rules },
  { files: ["eslint.config.js"], languageOptions: { sourceType: "commonjs", globals: node }, rules },
];
