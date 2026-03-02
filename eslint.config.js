export default [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "gen/**",
      "spec-kit-cn/**"
    ]
  },
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module"
    },
    rules: {}
  }
]
