/// <reference types="vitest/config" />
import { defineConfig } from 'vite'

// LLM endpoint baked into the CSP connect-src at build time:
//   VITE_LLM_ENDPOINT=https://api.example.com npm run build
const llmEndpoint = process.env.VITE_LLM_ENDPOINT || ''

export default defineConfig({
  // Relative base so the built app works under a scoped deploy path
  // (e.g. https://host/listentopr/), matching sw.js and manifest paths.
  base: './',
  plugins: [
    {
      name: 'csp-llm-endpoint',
      transformIndexHtml(html) {
        return html.replace('__CSP_LLM_ENDPOINT__', llmEndpoint).replace(
          /<meta http-equiv="Content-Security-Policy"[^>]*>/,
          (m) => (llmEndpoint ? m : m.replace(/\s*__CSP_LLM_ENDPOINT__,?/, ''))
        )
      },
    },
  ],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
