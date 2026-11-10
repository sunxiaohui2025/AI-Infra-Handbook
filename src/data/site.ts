/** 全站站点级配置。 */

/** 后端（运营后台 / 访问统计 / 反馈）服务地址。
 *  - 留空 `''`（默认）：同源。适合把后端与站点放在同一域名/网关下，或用 dev 代理。
 *  - 后端独立部署时：填它完整地址，**不要带结尾斜杠**，例如 `https://admin.example.com`。
 *  - 构建前可用环境变量 `PUBLIC_BACKEND_BASE` 覆盖，无需改代码。
 */
export const BACKEND_BASE: string = (import.meta.env.PUBLIC_BACKEND_BASE as string | undefined) ?? '';

/** 把后端相对路径拼成完整地址。 */
export function backendUrl(path: string): string {
  return BACKEND_BASE + path;
}
