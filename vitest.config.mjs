import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    {
      // esbuild `?raw` loader is a build-time mechanism; tests only need the
      // modules to resolve (profile/install.ts imports the bridge assets).
      name: "dsh-raw-assets",
      enforce: "pre",
      transform(_code, id) {
        if (id.includes("?raw")) {
          return { code: 'export default "RAW_MOCK";', map: null };
        }
      },
    },
  ],
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});