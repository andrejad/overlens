import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Standard Vite React+TS scaffold (REQ_OVR_007). `build` output (dist/) is what internal/webui
// embeds into the Go binary (REQ_OVR_008).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Dev only: forward /api to the Go backend (`make run`, port 8080) so `npm run dev` works same-origin.
  server: { proxy: { '/api': 'http://localhost:8080' } },
})
