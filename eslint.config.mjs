/*
 * ESLint flat config.
 *
 * The project mixes three runtimes in one tree — Node (server/, main.js),
 * Chromium renderers (overlay/, control/, remote/, chatwindow/) and Jest
 * (tests/) — so the globals of all three are declared together. This trades a
 * little precision for zero false `no-undef` noise on a codebase this size.
 *
 * The control panel and the standalone CSS editor are browser ES modules; the
 * rest of the tree is classic scripts / CommonJS, so `sourceType` is overridden
 * for those paths.
 *
 * `eslint-config-prettier` is last of the shared configs: it switches off the
 * stylistic rules that would otherwise fight with Prettier.
 */

import js from "@eslint/js";
import globals from "globals";
import prettier from "eslint-config-prettier";

const appGlobals = {
  // Global objects injected by <script> tags in the renderer pages (see the
  // shared/ directory). ESLint can't see cross-script globals, so declare them.
  SharedEvents: "readonly",
  SharedIcons: "readonly",
  WidgetCatalog: "readonly",
  I18n: "readonly",
  MicFrame: "readonly",
  MicDSP: "readonly",
  BuiltinThemes: "readonly",
  SceneCatalog: "readonly",
  ThemeEngine: "readonly",
  CssEditorCore: "readonly",
  SharedTesoEmblem: "readonly",
  HangarCycle: "readonly",
  OSEWidgets: "readonly",
  TwitchEmotes: "readonly",
};

const sharedGlobals = {
  ...globals.node,
  ...globals.browser,
  ...globals.jest,
  ...appGlobals,
};

export default [
  {
    ignores: ["node_modules/**", "release/**", "backup/**", "coverage/**"],
  },
  js.configs.recommended,
  prettier,
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: sharedGlobals,
    },
    rules: {
      // `_`-prefixed args/catch bindings are the codebase's way of marking
      // intentionally unused values (catch {}, subclass hooks, mocks).
      "no-unused-vars": [
        "error",
        {
          args: "after-used",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      // Empty `catch {}` is deliberate in a lot of best-effort teardown paths.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    // Browser ES modules: control panel, its modules and the CSS editor window.
    files: ["control/**/*.js", "csseditor/**/*.js", "**/*.mjs"],
    languageOptions: {
      sourceType: "module",
      globals: sharedGlobals,
    },
  },
];
