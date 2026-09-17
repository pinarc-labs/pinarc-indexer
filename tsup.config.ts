import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  dts: { entry: "src/index.ts" },
  sourcemap: true,
  clean: true,
  target: "node24",
  platform: "node",
  removeNodeProtocol: false,
  external: ["viem", "@pinarc-labs/robinhood-chain-kit", "@pinarc-labs/sdk", "node:sqlite"],
});
