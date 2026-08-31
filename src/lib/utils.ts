import { Platform } from "./types";
import { isGoogleMapsUrl } from "./gmaps";

export function detectPlatform(url: string): Platform {
  // Google Maps 先判：分享連結有多種形態，交給 gmaps.ts 做嚴格 host 比對
  if (isGoogleMapsUrl(url)) return "googlemaps";
  if (url.includes("instagram.com") || url.includes("instagr.am")) return "instagram";
  if (url.includes("xiaohongshu.com") || url.includes("xhslink.com")) return "xiaohongshu";
  if (url.includes("youtube.com") || url.includes("youtu.be")) return "youtube";
  if (url.includes("tiktok.com")) return "tiktok";
  return "other";
}

export function platformEmoji(platform: Platform): string {
  switch (platform) {
    case "instagram": return "📸";
    case "xiaohongshu": return "📕";
    case "youtube": return "▶️";
    case "tiktok": return "🎵";
    case "googlemaps": return "🗺️";
    default: return "🔗";
  }
}

export function placeTypeEmoji(type: string | null): string {
  switch (type) {
    case "restaurant": return "🍽️";
    case "cafe": return "☕";
    case "attraction": return "🏞️";
    case "bar": return "🍺";
    case "hotel": return "🏨";
    case "bakery": return "🥐";
    case "dessert": return "🍰";
    case "nightmarket": return "🏮";
    default: return "📍";
  }
}
