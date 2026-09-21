/**
 * PM2 配置（生产：www.flylegal.cn）
 *
 * ⚠️ 本文件此前是**裸 JSON 却用了 .cjs 扩展名**，`require` 会直接抛
 * `Unexpected token ':'` —— 也就是说它从未能被 PM2 加载，线上一直是手工
 * `npm run server` 启动的（无自愈、无开机自启）。现改为合法的 CommonJS 导出。
 *
 * ⚠️ instances 必须保持 1、exec_mode 必须保持 fork。
 * 后端有进程内状态：会话材料存储（追问时取回此前上传的材料）、向量索引缓存、
 * SiliconFlow 降级健康计数。改成 cluster 多实例后，追问请求可能落到另一个 worker，
 * 导致"附件记忆"间歇性失效——这类 bug 极难排查。
 *
 * 端口不在这里写死：应用从 .env.local 的 LOCAL_SERVER_PORT 读取（生产为 8790）。
 */
module.exports = {
  apps: [
    {
      name: 'infimind-server',
      script: 'server/index.js',
      cwd: '/www/wwwroot/www.flylegal.cn/agent-api-v2',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production'
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './logs/server-error.log',
      out_file: './logs/server-out.log',
      merge_logs: true,
      max_memory_restart: '512M'
    }
  ]
}
