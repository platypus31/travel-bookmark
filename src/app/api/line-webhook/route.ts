import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import { detectPlatform, platformEmoji, placeTypeEmoji } from "@/lib/utils";
import { PLATFORM_LABELS } from "@/lib/types";
import { cleanCaption, looksLikeListPost } from "@/lib/caption";
import {
  resolveGoogleMapsUrl,
  parseGoogleMapsUrl,
  googleMapsPlaceText,
} from "@/lib/gmaps";

const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET || "";
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const DEFAULT_GROUP_ID = process.env.LINE_DEFAULT_GROUP_ID || "";
const DEFAULT_USER_ID = process.env.LINE_DEFAULT_USER_ID || "";

// Server-side Supabase client (anon key + RPC with SECURITY DEFINER)
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

function verifySignature(body: string, signature: string): boolean {
  const hash = crypto
    .createHmac("SHA256", CHANNEL_SECRET)
    .update(body)
    .digest("base64");
  return hash === signature;
}

async function replyMessage(replyToken: string, messages: { type: string; text: string }[]) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  });
}

const CITIES = [
  "台北", "新北", "基隆", "桃園", "新竹", "苗栗",
  "台中", "彰化", "南投", "雲林",
  "嘉義", "台南", "高雄", "屏東",
  "宜蘭", "花蓮", "台東",
  "澎湖", "金門", "馬祖",
];

function extractUrl(text: string): string | null {
  const urlRegex = /(https?:\/\/[^\s]+)/;
  const match = text.match(urlRegex);
  return match ? match[1] : null;
}

function extractCity(text: string): string | null {
  for (const city of CITIES) {
    if (text.includes(city)) return city;
  }
  return null;
}

function guessPlaceType(text: string): string | null {
  const lower = text.toLowerCase();
  if (/餐廳|美食|小吃|料理|麵|飯|鍋|燒烤|bbq|food|restaurant|拉麵|壽司|丼|串燒|熱炒|牛排|火鍋|滷肉/.test(lower)) return "restaurant";
  if (/咖啡|cafe|coffee|甜點|蛋糕|下午茶|dessert/.test(lower)) return "cafe";
  if (/酒吧|bar|pub|調酒|居酒屋|啤酒/.test(lower)) return "bar";
  if (/住宿|飯店|民宿|hotel|旅館|villa|露營|glamping/.test(lower)) return "hotel";
  if (/景點|秘境|步道|瀑布|海邊|山|溫泉|古蹟|老街|夜景|觀景/.test(lower)) return "attraction";
  return null;
}

// Try to extract a place/shop name from caption text
// Looks for patterns like "店名 XX店/廳/館" or short standalone names
function extractPlaceName(caption: string): string | null {
  if (!caption) return null;

  // Pattern 1: Look for text ending with common place suffixes
  // e.g., "羊燒味 溫體羊肉專賣店", "老宅咖啡廳", "XX燒烤店"
  const suffixPattern = /([^\s，,。！!？?、\n]{2,15}(?:店|廳|館|堂|舍|居|屋|坊|軒|閣|苑|齋|號|樓|亭|寮|小吃|食堂|餐廳|咖啡|酒吧|旅館|民宿|飯店))/g;
  const suffixMatches = caption.match(suffixPattern);
  if (suffixMatches) {
    // Pick the longest match as it's likely the full name
    const best = suffixMatches.sort((a, b) => b.length - a.length)[0];
    // Clean up leading filler words
    return best.replace(/^[的在是有個一這那去到了也都很超好最]/, '').trim();
  }

  // Pattern 2: Look for quoted names「XX」or【XX】
  const quotedMatch = caption.match(/[「【]([^」】]{2,20})[」】]/);
  if (quotedMatch) return quotedMatch[1];

  // Pattern 3: If the caption is short enough (≤15 chars), it might be the name itself
  const firstLine = caption.split(/[\n\r]/)[0].trim();
  if (firstLine.length <= 15 && !/[？?！!]/.test(firstLine)) {
    return firstLine;
  }

  return null;
}

// Fetch OG meta from URL for auto-classification
async function fetchOgMeta(url: string): Promise<{ title: string | null; description: string | null; placeName: string | null; imageUrl: string | null }> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; TravelBookmarkBot/1.0)" },
      redirect: "follow",
      signal: AbortSignal.timeout(5000),
    });
    const html = await res.text();

    const ogTitle = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]*)"/)
      || html.match(/<meta[^>]*content="([^"]*)"[^>]*property="og:title"/);
    const ogDesc = html.match(/<meta[^>]*property="og:description"[^>]*content="([^"]*)"/)
      || html.match(/<meta[^>]*content="([^"]*)"[^>]*property="og:description"/);
    const titleTag = html.match(/<title[^>]*>([^<]*)<\/title>/);

    // Clean up IG-style titles
    // 2026-08-31：原本這裡自己 inline 解 &#x…; / &quot;，只解了 title 沒解 description，
    // 導致存進 DB 的描述整段是 entity（網頁搜尋搜不到中文、LLM 也讀不懂）。
    // 統一改用 cleanCaption()，title 與 description 走同一套。
    let rawTitle = cleanCaption(ogTitle?.[1] || titleTag?.[1] || null);
    if (rawTitle) {
      const igMatch = rawTitle.match(/在 Instagram[：:]\s*["""]?(.+)/) || rawTitle.match(/on Instagram[：:]\s*["""]?(.+)/);
      if (igMatch) {
        rawTitle = igMatch[1].replace(/["""]\s*$/, '');
      }
    }

    // ⚠️ description 這裡刻意保留「未清洗」的原文：
    // 呼叫端會把 title 與 description 併成一段之後再一次 cleanCaption()，
    // 這樣「og:title 就是文案第一行」造成的重複才有辦法被偵測掉。
    const rawDesc = ogDesc?.[1] || null;

    // Try to extract actual place name from title + description
    const combined = [rawTitle, cleanCaption(rawDesc)].filter(Boolean).join(" ");
    const placeName = extractPlaceName(combined);

    // For display: truncate rawTitle
    if (rawTitle) {
      rawTitle = rawTitle.split(/[\n\r]/)[0].trim();
      if (rawTitle.length > 60) {
        rawTitle = rawTitle.substring(0, 57) + '...';
      }
    }

    // Extract og:image
    const ogImage = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]*)"/)
      || html.match(/<meta[^>]*content="([^"]*)"[^>]*property="og:image"/);

    return {
      title: rawTitle,
      description: rawDesc,
      placeName,
      imageUrl: ogImage?.[1] || null,
    };
  } catch {
    return { title: null, description: null, placeName: null, imageUrl: null };
  }
}

async function handleUrl(url: string, extraText: string, replyToken: string) {
  const platform = detectPlatform(url);
  const cleanText = extraText.replace(/(https?:\/\/[^\s]+)/g, "").trim();

  // 1. Try to extract city from user's message text
  let city = extractCity(cleanText);
  let placeType = guessPlaceType(cleanText);

  // 2. 取得標題／描述
  // Google Maps 走 URL 解析：實測其 og:title 恆為 "Google Maps"、
  // og:description 恆為 "Find local businesses..."，抓 meta 只會存進垃圾標題。
  // 地點名稱與座標都在展開後的網址裡，不需要 Places API。
  let storedUrl = url;
  let og: Awaited<ReturnType<typeof fetchOgMeta>>;

  if (platform === "googlemaps") {
    const resolved = await resolveGoogleMapsUrl(url);
    const place = parseGoogleMapsUrl(resolved);
    storedUrl = place.canonicalUrl;
    og = {
      title: place.placeName,
      description: googleMapsPlaceText(place),
      placeName: place.placeName,
      imageUrl: null,
    };
  } else {
    og = await fetchOgMeta(url);
  }

  // 給 extractCity / guessPlaceType 用的文字：要用清洗過的版本，
  // 不然縣市名在 &#x53f0;&#x5357; 裡面，關鍵字比對永遠 miss。
  const ogCombined = [og.title, cleanCaption(og.description)].filter(Boolean).join(" ");

  // 3. Determine title: user text > extracted place name > OG title
  let title: string | null = cleanText || null;
  if (!title && og.placeName) {
    title = og.placeName;
  }
  // Store full OG caption as description (even if we extracted a place name from it)
  // Google Maps 例外：og.description（googleMapsPlaceText）本身已含「地點名稱：X」，
  // 使用者若另附文字會讓 title !== og.title，前綴 og.title 會使店名重複兩次。
  //
  // 2026-08-31：非 Google Maps 的情況一律再過一次 cleanCaption()。
  // 這一步同時做三件事：解 HTML entity、剝掉「583 likes, 23 comments - … on …:」的 IG 殼、
  // 去掉「og:title 與文案第一行重複」那一行。清乾淨的文案是多地點抽取的前提 ——
  // 模型看得懂整篇，才有辦法把「台南必吃 8 家」裡的 8 家一家一家挑出來。
  const description = platform === "googlemaps"
    ? og.description || null
    : cleanCaption(
        og.title && og.title !== title
          ? og.title + (og.description ? `\n${og.description}` : '')
          : og.description || null
      );

  // Try to extract city/placeType from OG meta if not found in user text
  if (!city) {
    city = extractCity(ogCombined);
  }
  if (!placeType) {
    placeType = guessPlaceType(ogCombined);
  }

  // Check if this URL already exists (RPC returns existing on conflict)
  const { data, error } = await supabase.rpc("insert_bookmark_from_bot", {
    p_group_id: DEFAULT_GROUP_ID,
    p_created_by: DEFAULT_USER_ID,
    p_url: storedUrl,
    p_platform: platform,
    p_title: title || og.title || null,
    p_description: description,
    p_image_url: og.imageUrl,
    p_city: city,
    p_place_type: placeType,
  });

  if (error) {
    // 線上 DB 的 bookmarks_platform_check 若還沒放行新平台，錯誤訊息很難懂，
    // 直接告訴使用者要跑哪個 migration，不要讓他對著 constraint 名稱猜。
    const needsMigration = error.message?.includes("bookmarks_platform_check");
    await replyMessage(replyToken, [
      {
        type: "text",
        text: needsMigration
          ? `❌ 資料庫還沒開放「${PLATFORM_LABELS[platform] || platform}」這個來源。\n請到 Supabase SQL Editor 跑一次：\nsupabase/migrations/2026-08-31-add-googlemaps-platform.sql`
          : `❌ 儲存失敗：${error.message}`,
      },
    ]);
    return;
  }

  // Detect duplicate: if returned record has a different created_at than now, it's existing
  const isDuplicate = data && new Date(data.created_at).getTime() < Date.now() - 10000;

  if (isDuplicate) {
    const existingTitle = data.title || "未命名";
    await replyMessage(replyToken, [
      { type: "text", text: `⚠️ 這個連結已經收藏過了！\n📌 ${existingTitle}${data.city ? `\n📍 ${data.city}` : ''}` },
    ]);
    return;
  }

  const emoji = platformEmoji(platform);
  const typeEmoji = placeTypeEmoji(placeType);
  const parts = [`${emoji} 已收藏！`];
  if (title) parts.push(`📌 ${title}`);
  if (!title && og.title) parts.push(`📝 ${og.title}`);
  if (city) parts.push(`📍 ${city}`);
  if (placeType) parts.push(`${typeEmoji} ${placeType}`);

  // 清單型貼文（「台南必吃 8 家」那種）：實際拆成幾筆是 enrich 排程每 2 分鐘跑一次時
  // 由 LLM 決定的，webhook 這邊只能看格式先給一句預告，免得他以為只收到一家。
  const isListPost = looksLikeListPost(description);
  if (isListPost) {
    parts.push(`\n📋 看起來是多家店的清單貼文，我會在幾分鐘內自動拆成多筆，到網頁看就會分開列出`);
  }

  if (!title) parts.push(`\n💡 沒偵測到店名，你可以到網頁上編輯`);
  if (!city) parts.push(`\n💡 我沒偵測到地區，你可以補充：「嘉義」就好`);

  await replyMessage(replyToken, [
    { type: "text", text: parts.join("\n") },
  ]);
}

async function handleQuery(text: string, replyToken: string) {
  const cityMatch = text.match(/(台北|新北|基隆|桃園|新竹|苗栗|台中|彰化|南投|雲林|嘉義|台南|高雄|屏東|宜蘭|花蓮|台東|澎湖|金門|馬祖)/);

  if (cityMatch) {
    const city = cityMatch[1];
    const { data } = await supabase.rpc("query_bookmarks_by_city", {
      p_group_id: DEFAULT_GROUP_ID,
      p_city: city,
    });

    const bookmarks = data || [];
    if (bookmarks.length === 0) {
      await replyMessage(replyToken, [
        { type: "text", text: `📍 ${city} 目前沒有收藏，傳連結給我開始收集吧！` },
      ]);
      return;
    }

    const list = bookmarks
      .map((b: Record<string, string | boolean>, i: number) => {
        const emoji = placeTypeEmoji(b.place_type as string);
        const visited = b.visited ? "✅" : "⬜";
        return `${i + 1}. ${visited} ${emoji} ${b.title || "未命名"}\n   ${b.url}`;
      })
      .join("\n\n");

    await replyMessage(replyToken, [
      { type: "text", text: `📍 ${city} 的收藏（${bookmarks.length} 筆）：\n\n${list}` },
    ]);
    return;
  }

  // General search
  const { data } = await supabase.rpc("search_bookmarks", {
    p_group_id: DEFAULT_GROUP_ID,
    p_keyword: text,
  });

  const bookmarks = data || [];
  if (bookmarks.length === 0) {
    await replyMessage(replyToken, [
      { type: "text", text: `🔍 找不到「${text}」相關的收藏。\n\n💡 傳連結收藏，或輸入縣市名查看該地區收藏！` },
    ]);
    return;
  }

  const list = bookmarks
    .map((b: Record<string, string>, i: number) => `${i + 1}. ${placeTypeEmoji(b.place_type)} ${b.title || "未命名"}（${b.city || "未分類"}）\n   ${b.url}`)
    .join("\n\n");

  await replyMessage(replyToken, [
    { type: "text", text: `🔍 「${text}」的搜尋結果：\n\n${list}` },
  ]);
}

async function handleStats(replyToken: string) {
  const { data } = await supabase.rpc("bookmark_stats", {
    p_group_id: DEFAULT_GROUP_ID,
  });

  const stats = data || { total: 0, by_city: [] };
  const cityList = (stats.by_city || [])
    .map((c: { city: string; count: number }) => `  ${c.city}: ${c.count}`)
    .join("\n");

  await replyMessage(replyToken, [
    {
      type: "text",
      text: `📊 收藏統計\n\n總共：${stats.total} 筆\n\n按地區：\n${cityList || "  尚無資料"}`,
    },
  ]);
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  const signature = req.headers.get("x-line-signature") || "";

  if (!verifySignature(body, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
  }

  const payload = JSON.parse(body);
  const events = payload.events || [];

  for (const event of events) {
    if (event.type !== "message" || !event.replyToken) continue;

    const { message, replyToken } = event;

    if (message.type === "text") {
      const text = message.text.trim();
      const url = extractUrl(text);

      if (url) {
        await handleUrl(url, text, replyToken);
      } else if (/^(help|說明|幫助)$/i.test(text)) {
        await replyMessage(replyToken, [
          {
            type: "text",
            text: `📍 Travel Bookmark 使用說明\n\n🔗 傳連結 → 自動收藏\n支援 IG / 小紅書 / YouTube / TikTok / Google Maps\n\n🗺️ Google Maps 直接用 App 的「分享」貼過來就好\n（maps.app.goo.gl 短網址會自動展開成店名）\n\n🔍 輸入縣市名 → 查看該地區收藏\n例：「台南」「花蓮」\n\n🔎 輸入關鍵字 → 搜尋收藏\n例：「燒烤」「咖啡」\n\n📊 輸入「統計」→ 查看收藏統計`,
          },
        ]);
      } else if (/^(統計|stats)$/i.test(text)) {
        await handleStats(replyToken);
      } else {
        await handleQuery(text, replyToken);
      }
    } else if (message.type === "image") {
      await replyMessage(replyToken, [
        { type: "text", text: "📸 收到圖片！圖片辨識功能開發中，請先傳連結或文字描述 🙏" },
      ]);
    }
  }

  return NextResponse.json({ status: "ok" });
}

export async function GET() {
  return NextResponse.json({ status: "Travel Bookmark LINE Bot is running" });
}
