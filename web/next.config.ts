import type { NextConfig } from 'next';
import path from 'node:path';
const localTest = process.env.CT_LOCAL_TEST_BUILD === 'yes';
if (
  localTest &&
  (process.env.CT_RUNTIME_ENV !== 'local-test' ||
    process.env.CT_ALLOW_LOCAL_FIXTURES !== 'yes')
)
  throw Error('Explicit dedicated local-test build required');
const config: NextConfig = {
  distDir: localTest ? '.next-local-test' : '.next',
  env: { CT_COMPILED_PROFILE: localTest ? 'LOCAL_TEST' : 'PRODUCT' },
  poweredByHeader: false,
  outputFileTracingRoot: path.resolve(process.cwd(), '..'),
  turbopack: { root: path.resolve(process.cwd(), '..') },
  reactStrictMode: true,
  output: 'standalone',
  experimental: { cpus: 2 },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};
export default config;
