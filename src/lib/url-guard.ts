// SSRF 防線：/api/preview 會「拿使用者給的網址、由伺服器實際發出請求」，
// 沒有限制的話，同網段的任何裝置都能透過它去打內網（本機 server 監聽 *:3100，
// 不是只有 127.0.0.1）——2026-08-31 架構盤點 ②的補充。
//
// 兩層防線，缺一不可：
//   ① 網域白名單：只放行這個專案真的會收藏的平台（實查 DB 243 筆只有 www.instagram.com
//      與 xhslink.com；再加上 src/lib/utils.ts detectPlatform 支援、LINE 說明文列出的其餘平台）
//   ② 私有網段封鎖：白名單理論上已排除 IP 字面值，但轉址／未來放寬白名單時它是最後一道牆
//
// 🔴 只驗第一次輸入是不夠的：白名單網域可以回一個 302 指向 127.0.0.1。
//    所以 fetchGuarded() 用 redirect:"manual" 自己跟隨，**每一跳都重驗**。

/** 允許 server 端主動抓取的網域（含子網域）。Google Maps 走 gmaps.ts 自己的解析路徑，不在此。 */
const ALLOWED_DOMAINS = [
  // 實際收藏來源（DB 實查）
  "instagram.com",
  "instagr.am",
  "xiaohongshu.com",
  "xhslink.com",
  // detectPlatform() 支援 + LINE 說明文宣稱支援
  "youtube.com",
  "youtu.be",
  "tiktok.com",
  // Threads 貼文（IG 同源，使用者也會貼）
  "threads.com",
  "threads.net",
];

function normalizeHost(hostname: string): string {
  // IPv6 在 URL.hostname 會帶中括號
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function ipv4Blocked(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return true; // 不合法就當危險
  if (a === 0) return true;                       // 0.0.0.0/8
  if (a === 10) return true;                      // 10/8
  if (a === 127) return true;                     // loopback
  if (a === 169 && b === 254) return true;        // link-local + 雲端 metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true;        // 192.168/16
  if (a === 192 && b === 0) return true;          // 192.0.0/24, 192.0.2/24
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
  if (a >= 224) return true;                      // multicast / reserved
  return false;
}

function ipv6Blocked(host: string): boolean {
  if (!host.includes(":")) return false;
  const h = host;
  if (h === "::" || h === "::1") return true;
  // ::ffff:127.0.0.1 這種 v4-mapped
  const mapped = h.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mapped) return ipv4Blocked(mapped[1]);
  if (/^f[cd]/i.test(h)) return true;   // fc00::/7 unique local
  if (/^fe[89ab]/i.test(h)) return true; // fe80::/10 link-local
  return true; // 其餘 IPv6 字面值一律不放行（白名單平台不會用它）
}

/** 內網／loopback／metadata 這類「絕對不能讓伺服器代打」的位址 */
export function isBlockedHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa")) return true;
  if (ipv4Blocked(host)) return true;
  if (ipv6Blocked(host)) return true;
  return false;
}

/** 網域在白名單內（含子網域，例如 www.instagram.com） */
export function isAllowedDomain(hostname: string): boolean {
  const host = normalizeHost(hostname);
  return ALLOWED_DOMAINS.some((d) => host === d || host.endsWith("." + d));
}

/**
 * 這個網址可不可以讓伺服器去抓。
 * 條件：http/https、沒有帳密、預設埠、網域在白名單、且不是內網位址。
 *
 * 為什麼不強制 https：DB 實查有 16 筆小紅書分享連結是 `http://xhslink.com/...`
 * （小紅書 app 就是這樣產的），強制 https 會讓這個平台整個收不進來。
 * 主機已經被白名單釘死在公開平台上，http 不會多出「打到內網」的能力。
 */
export function isFetchableUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.username || u.password) return false;
  const defaultPort = u.protocol === "https:" ? "443" : "80";
  if (u.port && u.port !== defaultPort) return false;
  if (isBlockedHost(u.hostname)) return false;
  return isAllowedDomain(u.hostname);
}

export class BlockedUrlError extends Error {
  constructor(url: string) {
    super("blocked url: " + url);
    this.name = "BlockedUrlError";
  }
}

/**
 * 白名單版 fetch：自己跟隨轉址，**每一跳都重驗**。
 * redirect:"follow" 會讓白名單網域用 302 把我們帶去內網，所以不能用。
 */
export async function fetchGuarded(
  url: string,
  init: RequestInit = {},
  maxHops = 4
): Promise<Response> {
  let current = url;
  for (let hop = 0; hop < maxHops; hop++) {
    if (!isFetchableUrl(current)) throw new BlockedUrlError(current);
    const res = await fetch(current, { ...init, redirect: "manual" });
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get("location");
    if (!location) return res;
    let next: string;
    try {
      next = new URL(location, current).toString();
    } catch {
      throw new BlockedUrlError(location);
    }
    current = next;
  }
  throw new BlockedUrlError("too many redirects: " + url);
}
