import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // El repo raíz tiene su propio package-lock.json (proyecto de ingesta),
  // así que Turbopack detecta dos lockfiles y ambigua la raíz del
  // workspace. Fijamos `web/` como raíz explícitamente.
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
