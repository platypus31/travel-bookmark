import { NextRequest, NextResponse } from "next/server";
import {
  isGoogleMapsUrl,
  resolveGoogleMapsUrl,
  parseGoogleMapsUrl,
  googleMapsPlaceText,
} from "@/lib/gmaps";
import { cleanCaption } from "@/lib/caption";

interface PreviewData {
  title: string | null;
  description: string | null;
  image: string | null;
  /** Google Maps 專用：展開／清乾淨後的網址，前端會用它取代使用者貼的短網址 */
  resolvedUrl?: string;
}

function extractMeta(html: string, property: string): string | null {
  // Match og:, twitter:, and regular meta tags
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, "i"),
    new RegExp(`<meta[^>]+name=["']${property}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${property}["']`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match?.[1]?.trim() || null;
}

export async function POST(request: NextRequest) {
  try {
    const { url } = await request.json();

    if (!url || typeof url !== "string") {
      return NextResponse.json({ error: "URL is required" }, { status: 400 });
    }

    // Validate URL format
    try {
      new URL(url);
    } catch {
      return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
    }

    // Google Maps 的 og meta 是固定樣板（title 恆為 "Google Maps"），
    // 抓網頁沒有意義 — 名稱與座標都在網址裡，短網址展開一次就有。
    if (isGoogleMapsUrl(url)) {
      const resolved = await resolveGoogleMapsUrl(url);
      const place = parseGoogleMapsUrl(resolved);
      const mapsPreview: PreviewData = {
        title: place.placeName,
        description: googleMapsPlaceText(place),
        image: null,
        resolvedUrl: place.canonicalUrl,
      };
      return NextResponse.json(mapsPreview);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; TravelBookmarkBot/1.0)",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
      },
      redirect: "follow",
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const html = await response.text();
    // Only parse first 50KB to avoid memory issues
    const truncated = html.slice(0, 50000);

    // 2026-08-31：title / description 都過 cleanCaption()。
    // 沒清的時候，網頁「新增收藏」的預覽卡會直接顯示 &#x53f0;&#x5357; 這種東西，
    // 而且使用者按下儲存就把整段 entity 原封不動存進 DB（與 LINE 那邊同一個病）。
    const preview: PreviewData = {
      title: cleanCaption(
        extractMeta(truncated, "og:title") ||
        extractMeta(truncated, "twitter:title") ||
        extractTitle(truncated)
      ),
      description: cleanCaption(
        extractMeta(truncated, "og:description") ||
        extractMeta(truncated, "twitter:description") ||
        extractMeta(truncated, "description")
      ),
      image:
        extractMeta(truncated, "og:image") ||
        extractMeta(truncated, "twitter:image"),
    };

    return NextResponse.json(preview);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch preview";
    return NextResponse.json({ title: null, description: null, image: null, error: message });
  }
}
