import type {NextConfig} from "next";
const config:NextConfig={output:"standalone",poweredByHeader:false,experimental:{cpus:2},outputFileTracingExcludes:{"/*":["./qualification/**/*","./data/**/*","./.pnpm-store/**/*"]}};
export default config;
