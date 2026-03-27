import { NextRequest, NextResponse } from "next/server";

interface PreviewData {
  title: string | null;
  description: string | null;
  image: string | null;
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

    const preview: PreviewData = {
      title:
        extractMeta(truncated, "og:title") ||
        extractMeta(truncated, "twitter:title") ||
        extractTitle(truncated),
      description:
        extractMeta(truncated, "og:description") ||
        extractMeta(truncated, "twitter:description") ||
        extractMeta(truncated, "description"),
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
