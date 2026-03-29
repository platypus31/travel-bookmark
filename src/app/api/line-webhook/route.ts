import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import { detectPlatform, platformEmoji, placeTypeEmoji } from "@/lib/utils";

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

function extractUrl(text: string): string | null {
  const urlRegex = /(https?:\/\/[^\s]+)/;
  const match = text.match(urlRegex);
  return match ? match[1] : null;
}

function guessPlaceType(text: string): string | null {
  const lower = text.toLowerCase();
  if (/餐廳|美食|小吃|料理|麵|飯|鍋|燒烤|bbq|food|restaurant/.test(lower)) return "restaurant";
  if (/咖啡|cafe|coffee/.test(lower)) return "cafe";
  if (/酒吧|bar|pub|調酒/.test(lower)) return "bar";
  if (/住宿|飯店|民宿|hotel|旅館/.test(lower)) return "hotel";
  if (/景點|秘境|步道|瀑布|海邊|山/.test(lower)) return "attraction";
  return null;
}

async function handleUrl(url: string, extraText: string, replyToken: string) {
  const platform = detectPlatform(url);
  const placeType = guessPlaceType(extraText);
  const cleanText = extraText.replace(/(https?:\/\/[^\s]+)/g, "").trim();

  const { data, error } = await supabase.rpc("insert_bookmark_from_bot", {
    p_group_id: DEFAULT_GROUP_ID,
    p_created_by: DEFAULT_USER_ID,
    p_url: url,
    p_platform: platform,
    p_title: cleanText || null,
    p_place_type: placeType,
  });

  if (error) {
    await replyMessage(replyToken, [
      { type: "text", text: `❌ 儲存失敗：${error.message}` },
    ]);
    return;
  }

  const emoji = platformEmoji(platform);
  const typeEmoji = placeTypeEmoji(placeType);
  await replyMessage(replyToken, [
    {
      type: "text",
      text: `${emoji} 已收藏！${cleanText ? `\n📌 ${cleanText}` : ""}${placeType ? `\n${typeEmoji} ${placeType}` : ""}\n\n💡 之後可以在網頁上補地區和標籤`,
    },
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
            text: `📍 Travel Bookmark 使用說明\n\n🔗 傳連結 → 自動收藏\n支援 IG / 小紅書 / YouTube / TikTok\n\n🔍 輸入縣市名 → 查看該地區收藏\n例：「台南」「花蓮」\n\n🔎 輸入關鍵字 → 搜尋收藏\n例：「燒烤」「咖啡」\n\n📊 輸入「統計」→ 查看收藏統計`,
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
