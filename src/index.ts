#!/usr/bin/env node

export {};

if (process.argv.includes("--setup")) {
  const { runSetup } = await import("./setup.js");
  runSetup();
  process.exit(0);
}

await import("./server.js");
