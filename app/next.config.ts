import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";

// The repository keeps a single `.env` at its root, shared with the keeper;
// Next.js would otherwise only look inside `app/`.
loadEnvConfig("..");

const nextConfig: NextConfig = {};

export default nextConfig;
