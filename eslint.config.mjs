import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["main.js", "node_modules/", "reference/", "test-vault/", "*.mjs"] },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      // Module handlers are async by contract even when they don't await.
      "@typescript-eslint/require-await": "off",
      "no-console": ["error", { allow: ["debug", "warn", "error"] }],
    },
  },
  {
    // Tests and the obsidian stub trade type-safety for brevity.
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
