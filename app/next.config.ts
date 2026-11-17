import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { NextConfig } from "next";

// The repository keeps a single `.env` at its root, shared with the keeper;
// Next.js only reads env files inside `app/`. `@next/env` cannot do this
// here: Next.js calls it before loading this file and it returns its cached
// result. `process.loadEnvFile` does not override variables already set.
const rootEnv = resolve(process.cwd(), "..", ".env");
if (existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
}

const nextConfig: NextConfig = {};

export default nextConfig;
