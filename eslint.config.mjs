import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    // `eslint .` walks the whole tree, so the generated output has to be named
    // here rather than left out of the command's arguments. `dist/` and
    // `public/` are build products and `coverage/` is a test artefact; linting
    // them means linting webpack's bundle.
    ignores: ['dist/**', 'public/**', 'coverage/**'],
  },
  // Type-aware rather than the syntactic `recommended`: this plugin is almost
  // entirely async HTTP and WebSocket relaying, and the rules that catch the
  // mistakes that actually break it — no-floating-promises, no-misused-promises,
  // await-thenable — exist only in the checked variant. Without a program they
  // are silently unavailable, not merely off.
  ...tseslint.configs.recommendedTypeChecked,
  prettier,
  {
    languageOptions: {
      parserOptions: {
        // The service resolves each file to the nearest tsconfig.json, which is
        // the root one — the only config that spans both src/ and test/.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Staged to 'error' once the existing findings are cleared. Turning the
    // type-aware rules on surfaced a backlog in code that predates them;
    // 'warn' keeps every one of them reported and keeps new code honest
    // without failing a build over the backlog. These four have findings in
    // src/ as well as test/, so they are downgraded everywhere.
    rules: {
      '@typescript-eslint/no-misused-promises': 'warn',
      '@typescript-eslint/no-unnecessary-type-assertion': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/require-await': 'warn',
    },
  },
  {
    // The remaining backlog is confined to the test suite, where mocks are
    // untyped by nature and assertions are deliberately loose. Kept at 'error'
    // for src/ — a floating promise in the relay code is the exact bug class
    // these rules exist to catch — and staged to 'error' here too once the
    // suite's findings are cleared.
    files: ['test/**'],
    rules: {
      '@typescript-eslint/no-base-to-string': 'warn',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/prefer-promise-reject-errors': 'warn',
    },
  },
  {
    // The build and tooling scripts are plain JavaScript and belong to no
    // tsconfig, so the type-aware rules have no program to ask and would fail
    // the run outright. They are still parsed and still linted syntactically.
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      // webpack.config.js and the screenshot tooling are CommonJS, which is
      // what the tools consuming them expect; `require` is the module system
      // there, not a lapse. The rule stays an error for TypeScript.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
