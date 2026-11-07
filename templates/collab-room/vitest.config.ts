// Component tests (jsdom). The pure-module tests in test/*.test.ts stay on node:test (npm test runs both).
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  define: {
    __COLLAB_MODE__: JSON.stringify("mock"),
    __COLLAB_ROOM__: JSON.stringify(""),
    __FARM__: "false",
    __VTA_BROWSER_URL__: JSON.stringify("http://vta.test"),
    __VTA_URL__: JSON.stringify("http://vta.test"),
    __VTC_BROWSER_URL__: JSON.stringify("http://vtc.test"),
    __VTC_URL__: JSON.stringify("http://vtc.test"),
  },
  test: {
    environment: "jsdom",
    include: ["test/ui/**/*.test.tsx"],
    setupFiles: ["test/ui/setup.ts"],
    restoreMocks: false,
    testTimeout: 20_000,
  },
});
