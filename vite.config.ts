import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/incognitochatapp/', // REPO NAME HERE
  build: {
    outDir: 'dist',
    sourcemap: false
  }
});