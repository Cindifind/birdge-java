import { defineConfig } from 'vitest/config'

// Only this plugin's tests: the Bot repository next door has its own config
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
})
