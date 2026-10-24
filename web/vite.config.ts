import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// 看板以单个 HTML 打进插件动态库(go:embed),因此内联全部资源
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    host: "127.0.0.1",
    proxy: {
      // 作者：long。开发请求只转发到本机 CPA，不接受页面参数选定目标，也不跟随宿主跳转。
      "/v0/management/plugins/cpa-usage-stats/": {
        target: "http://127.0.0.1:8317",
        followRedirects: false,
      },
    },
  },
  build: {
    target: "esnext",
    cssCodeSplit: false,
  },
});
