// Isolated, localhost-only review of the actual medical page. Public routes,
// existing dev services, .env, real account data and dist are not modified.
import { cp, mkdir, mkdtemp, readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer as createPortProbe } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, createServer } from 'vite'
import react from '@vitejs/plugin-react'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const appReview = process.argv.includes('--app')
const root = await mkdtemp(join(tmpdir(), 'fafee-medical-review-'))
await cp(join(repo, 'src'), join(root, 'src'), { recursive: true })
await mkdir(join(root, 'public'))
await cp(join(repo, 'public/logo.png'), join(root, 'public/logo.png'))
if (appReview) {
  // Only static frontend assets and the existing upload-limit constant are
  // needed to load App; no server, .env, database or business materials copied.
  for (const name of await readdir(join(repo, 'public'))) {
    if (/\.(png|svg|ico|jpg|jpeg|webp)$/i.test(name)) await cp(join(repo, 'public', name), join(root, 'public', name))
  }
  await mkdir(join(root, 'server/services'), { recursive: true })
  await cp(join(repo, 'server/services/upload-config.js'), join(root, 'server/services/upload-config.js'))
}
await symlink(join(repo, 'node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', private: true }))
await writeFile(join(root, 'index.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="/logo.png"><title>医疗期功能隔离审阅</title></head><body><div id="root"></div><script type="module" src="/review.jsx"></script></body></html>')
await writeFile(join(root, 'review.jsx'), `import React from 'react'
import { createRoot } from 'react-dom/client'
${appReview ? "import App from './src/App.jsx'" : "import { BrowserRouter } from 'react-router-dom'\nimport { MedicalCalculatorWorkspace } from './src/pages/MedicalCalculatorPage.jsx'"}
import './src/index.css'
document.body.classList.add('loaded')
createRoot(document.getElementById('root')).render(<React.StrictMode>${appReview ? '<App />' : '<BrowserRouter><MedicalCalculatorWorkspace userId="fictional-medical-review-user" /></BrowserRouter>'}</React.StrictMode>)
`)
const config = {
  root, configFile: false, envDir: root, cacheDir: join(root, '.vite-cache'),
  plugins: [react()], server: { host: '127.0.0.1', port: 0, strictPort: true },
  build: { outDir: join(root, 'review-build'), emptyOutDir: true }
}
if (process.argv.includes('--build')) {
  await build(config)
  console.log(JSON.stringify({ type: 'medical-review-build', root, status: 'passed', scope: appReview ? 'application' : 'medical-page' }))
} else {
  const portIndex = process.argv.indexOf('--port')
  if (portIndex >= 0) config.server.port = Number(process.argv[portIndex + 1])
  if (!config.server.port) {
    const probe = createPortProbe()
    await new Promise((ready, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', ready) })
    config.server.port = probe.address().port
    await new Promise((ready, reject) => probe.close((error) => error ? reject(error) : ready()))
  }
  const server = await createServer(config)
  await server.listen()
  const address = server.httpServer.address()
  console.log(JSON.stringify({ type: 'medical-review-ready', url: `http://127.0.0.1:${address.port}`, root, scope: appReview ? 'application' : 'medical-page' }))
  const stop = async () => { await server.close(); process.exit(0) }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
