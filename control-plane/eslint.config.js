// ESLint (flat config, v9) del control-plane. Sólo reglas que detectan errores reales
// (variables no definidas, claves duplicadas, código inalcanzable…): el estilo no se
// lintea, para que `npm run lint` sea una red de seguridad y no una discusión de formato.
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'test/fixtures/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.es2021 },
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'eqeqeq': 'off',
      'no-prototype-builtins': 'off',
      'no-useless-escape': 'off',
      'no-control-regex': 'off',
      'no-async-promise-executor': 'off',
      'no-cond-assign': ['error', 'except-parens'],
      'no-inner-declarations': 'off',
      // Estas dos entraron en el "recommended" de ESLint 10; acá casi siempre marcan el
      // patrón `let x = valor; try { x = ... } catch { }`, que es intencional. Quedan como
      // aviso para no tapar un caso real, pero no cortan el lint.
      'no-useless-assignment': 'warn',
      'preserve-caught-error': 'off',
    },
  },
];
