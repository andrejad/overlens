import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Standard Vite React+TS scaffold (REQ_OVR_007). `build` output (dist/) is what internal/webui
// embeds into the Go binary (REQ_OVR_008).
// start.sh passes the backend's port (REQ_DEPLOY_005); on its own, `npm run dev` goes to `make run` on 8080.
// changeOrigin off: /mcp builds its links and checks Origin from the Host the browser sent (REQ_API_059/063).
const backend = { target: `http://localhost:${process.env.OVERLENS_BACKEND_PORT ?? 8080}`, changeOrigin: false }

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Dev only: forward what the Go backend answers so the frontend's address works same-origin.
  server: { proxy: { '/api': backend, '/health': backend, '/mcp': backend } },
})
