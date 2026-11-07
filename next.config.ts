import type {NextConfig} from "next";
import {LEGACY_REDIRECTS} from "./lib/legacy-redirects";
const config:NextConfig={
  output:"standalone",
  poweredByHeader:false,
  experimental:{cpus:2},
  outputFileTracingExcludes:{"/*":["./qualification/**/*","./data/**/*","./.pnpm-store/**/*"]},
  async redirects(){return LEGACY_REDIRECTS.map((entry)=>({...entry}));},
};
export default config;
