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

const nextConfig: NextConfig = {
  async headers() {
    return [
      // Lets the iOS app (ios/) use the passkeys of this domain: Apple fetches
      // this file and requires it as JSON, though it has no extension.
      {
        source: "/.well-known/apple-app-site-association",
        headers: [{ key: "Content-Type", value: "application/json" }],
      },
      // A wallet signs payments and standing orders on these pages, so no other
      // site may frame them (clickjacking). Both headers: older browsers ignore CSP.
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
