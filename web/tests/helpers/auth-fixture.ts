// 作者：long。使用与管理中心一致的已保存格式作为输入，验证真实格式兼容而非绕过解析器。
export function encodeCenterState(value: unknown, host = "127.0.0.1:8317", prefix = "enc::v2::"): string {
  const key = Buffer.from(`cli-proxy-api-webui::secure-storage|${host}`);
  const bytes = Buffer.from(JSON.stringify(value));
  return prefix + Buffer.from(bytes.map((byte, i) => byte ^ key[i % key.length])).toString("base64");
}
