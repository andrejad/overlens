// ESLint (flat config): typescript-eslint's recommended rules, the React hooks rules and react-refresh's export check.
import { registerHooks } from 'node:module'

// typescript-eslint parses with TypeScript's JavaScript API, which TypeScript 7 (the compiler `npm run build` uses)
// no longer has. For the lint run only, 'typescript' resolves to @typescript/typescript6, the same language with that API.
registerHooks({ resolve: (specifier, context, next) => next(specifier === 'typescript' ? '@typescript/typescript6' : specifier, context) })

const { default: tseslint } = await import('typescript-eslint')
const { default: reactHooks } = await import('eslint-plugin-react-hooks')
const { default: reactRefresh } = await import('eslint-plugin-react-refresh')

// Helpers, hooks and contexts that live beside the one component they belong to. Fast refresh reloads such a file in
// full instead of patching it in place, which only costs a dev-server state reset; splitting each into its own file
// is not worth it.
const SHARED_BESIDE_COMPONENT = ['TopBarSlot', 'countLinks', 'plural', 'limitingItems', 'EDITOR_FONTS', 'EDITOR_SIZES', 'cleanLinks', 'spanProblem', 'showToast', 'suggestTag', 'useAuth', 'useCanEdit']

export default tseslint.config(
  { ignores: ['dist', 'test-results', 'playwright-report'] },
  tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      'react-refresh/only-export-components': ['error', { allowConstantExport: true, allowExportNames: SHARED_BESIDE_COMPONENT }],
    },
  },
)
