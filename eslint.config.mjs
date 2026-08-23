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
    // These ten were staged at 'warn' while the backlog they surfaced was
    // worked off — 272 findings in code that predates them. The backlog is
    // gone, so they are errors like the rest of the type-checked set, and the
    // next one to appear fails the run rather than joining a list.
    rules: {
      '@typescript-eslint/no-base-to-string': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/prefer-promise-reject-errors': 'error',
      '@typescript-eslint/require-await': 'error',
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
