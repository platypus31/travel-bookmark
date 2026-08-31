// Google Maps 分享連結解析
//
// 為什麼不接 Google Places API：分享連結本身已經帶了我們要的東西
//   - 桌面版 /maps/place/<名稱>/@<lat>,<lng> → 名稱 + 座標都在 URL 裡
//   - 手機短網址 maps.app.goo.gl/XXXX → 一次 302 就跳到上面那種完整網址
// 實測（2026-08-31）：Google Maps 頁面的 og:title 永遠是字串 "Google Maps"、
// og:description 永遠是 "Find local businesses..."，地址是 JS 才渲染的，
// 所以「抓網頁 meta」對 Maps 完全無效 —— 唯一可靠來源是 URL 本身。

export interface GoogleMapsPlace {
  /** 地點名稱（從 URL path 解出來的，可能為 null，例如只分享座標） */
  placeName: string | null;
  /** 緯度（優先取 data= 裡的 !3d，那是地點本身；@ 後面的是視窗中心） */
  lat: number | null;
  /** 經度 */
  lng: number | null;
  /** 解析後的正規化網址（短網址會被展開成完整的 /maps/place/... 網址） */
  canonicalUrl: string;
}

const SHORT_HOSTS = new Set(["maps.app.goo.gl", "goo.gl"]);

// 只認 google.<tld> 結尾，擋掉 maps.google.evil.com 這種偽裝
const GOOGLE_HOST_RE = /^(?:[a-z0-9-]+\.)*google\.(?:com|[a-z]{2}|com\.[a-z]{2}|co\.[a-z]{2})$/;

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** 是否為 Google Maps 短網址（需要 follow redirect 才知道是哪裡） */
export function isGoogleMapsShortUrl(url: string): boolean {
  const host = hostnameOf(url);
  if (!host || !SHORT_HOSTS.has(host)) return false;
  if (host === "maps.app.goo.gl") return true;
  // goo.gl 是通用短網址，只有 /maps/ 開頭才算地圖
  try {
    return new URL(url).pathname.startsWith("/maps");
  } catch {
    return false;
  }
}

/** 是否為 Google Maps 連結（含短網址與完整網址） */
export function isGoogleMapsUrl(url: string): boolean {
  if (isGoogleMapsShortUrl(url)) return true;
  const host = hostnameOf(url);
  if (!host || !GOOGLE_HOST_RE.test(host)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.pathname.startsWith("/maps")) return true;
  // maps.google.com/?q=... 這種沒有 /maps path 的舊寫法
  return host.startsWith("maps.") && parsed.searchParams.has("q");
}

const COORD_PAIR_RE = /^-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?$/;
// 「丟一根針」分享出來的不是店名，是度分秒座標（25°02'03.6"N 121°33'55.4"E），
// 當成標題存下去會很醜，寧可留空讓使用者自己打
const DMS_COORD_RE = /\d+\s*°\s*\d+['′]\s*[\d.]+\s*["″]?\s*[NSEW]/i;

function cleanName(raw: string): string | null {
  let name: string;
  try {
    name = decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    name = raw.replace(/\+/g, " ");
  }
  name = name.trim();
  if (!name) return null;
  // 這些不是地點名稱
  if (name.startsWith("@")) return null;
  if (/^(?:data=|place_id:|cid[:=]|ftid[:=])/i.test(name)) return null;
  if (COORD_PAIR_RE.test(name)) return null;
  if (DMS_COORD_RE.test(name)) return null;
  if (name.length > 120) return null;
  return name;
}

/**
 * 純字串解析，不連網。短網址請先用 resolveGoogleMapsUrl 展開再丟進來。
 */
export function parseGoogleMapsUrl(url: string): GoogleMapsPlace {
  const result: GoogleMapsPlace = {
    placeName: null,
    lat: null,
    lng: null,
    canonicalUrl: url,
  };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return result;
  }

  result.canonicalUrl = canonicalize(parsed);

  const segments = parsed.pathname.split("/").filter(Boolean);

  // /maps/place/<名稱>/... 或 /maps/search/<名稱>/...
  const anchorIdx = segments.findIndex((s) => s === "place" || s === "search");
  if (anchorIdx !== -1 && segments[anchorIdx + 1]) {
    result.placeName = cleanName(segments[anchorIdx + 1]);
  }

  // ?q= / ?query= — 可能是名稱，也可能是座標
  if (!result.placeName) {
    const q = parsed.searchParams.get("q") || parsed.searchParams.get("query");
    if (q) {
      if (COORD_PAIR_RE.test(q.trim())) {
        const [a, b] = q.split(",").map((n) => parseFloat(n));
        if (Number.isFinite(a) && Number.isFinite(b)) {
          result.lat = a;
          result.lng = b;
        }
      } else {
        result.placeName = cleanName(q);
      }
    }
  }

  // 座標：data= 裡的 !3d/!4d 是「地點本身」，@ 後面的是「視窗中心」，前者優先
  if (result.lat === null || result.lng === null) {
    const decoded = safeDecode(parsed.href);
    const dataCoords = decoded.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
    if (dataCoords) {
      result.lat = parseFloat(dataCoords[1]);
      result.lng = parseFloat(dataCoords[2]);
    } else {
      const atCoords = decoded.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
      if (atCoords) {
        result.lat = parseFloat(atCoords[1]);
        result.lng = parseFloat(atCoords[2]);
      }
    }
  }

  if (result.lat !== null && (result.lat < -90 || result.lat > 90)) result.lat = null;
  if (result.lng !== null && (result.lng < -180 || result.lng > 180)) result.lng = null;

  return result;
}

// 分享連結展開後會帶一堆一次性追蹤參數（entry / g_ep / skid…），
// 同一個連結每次解析都不一樣 → 直接存會讓 unique(group_id, url) 去重失效。
// 用 allowlist 只留真正帶資訊的參數。
// ⚠️ 這只解決「同一個分享連結」的去重。pathname 裡的 /@緯度,經度,縮放 是分享當下的
// 地圖視窗，同一家店分兩次分享會不一樣 → 那種重複由 enrich.sh 的 check_duplicate
// （比對店名+縣市，標「疑似重複」）接手，這裡不硬改 pathname 以免連結開不起來。
const KEEP_PARAMS = new Set(["q", "query", "cid", "ftid", "place_id", "api"]);

function canonicalize(parsed: URL): string {
  const kept = new URLSearchParams();
  for (const [k, v] of parsed.searchParams) {
    if (KEEP_PARAMS.has(k)) kept.set(k, v);
  }
  const qs = kept.toString();
  return `${parsed.origin}${parsed.pathname}${qs ? `?${qs}` : ""}`;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * 展開 Google Maps 短網址（server-side 用，會連網）。
 * 只跟隨指向 Google Maps 的 redirect，避免被短網址導去內網（SSRF）。
 * 非短網址直接原樣回傳，不會發出任何請求。
 */
export async function resolveGoogleMapsUrl(url: string, maxHops = 3): Promise<string> {
  let current = url;
  for (let hop = 0; hop < maxHops; hop++) {
    if (!isGoogleMapsShortUrl(current)) return current;
    let res: Response;
    try {
      res = await fetch(current, {
        method: "GET",
        redirect: "manual",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
          "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
        },
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      return current;
    }
    const location = res.headers.get("location");
    if (!location) return current;
    let next: string;
    try {
      next = new URL(location, current).toString();
    } catch {
      return current;
    }
    // 只接受跳到 Google Maps 的 redirect
    if (!isGoogleMapsUrl(next)) return current;
    current = next;
  }
  return current;
}

/**
 * 給 enrich / LLM 用的文字描述。Maps 沒有貼文內容，只能提供名稱與座標。
 */
export function googleMapsPlaceText(place: GoogleMapsPlace): string | null {
  const parts: string[] = [];
  if (place.placeName) parts.push(`地點名稱：${place.placeName}`);
  if (place.lat !== null && place.lng !== null) {
    parts.push(`座標：${place.lat},${place.lng}`);
  }
  return parts.length ? parts.join("\n") : null;
}
