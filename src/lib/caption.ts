/**
 * IG / 小紅書貼文文案的清洗工具。
 *
 * 為什麼需要：IG 的 og:description 長這樣（實測 2026-08-31，DB 裡 60 筆全是這形狀）
 *   583 likes, 23 comments - 77_____eat on March 26, 2026: &quot;&#x53f0;&#x5357;...&quot;.
 * 兩個問題：
 *   ① numeric HTML entity 沒還原 → 中文全變成 &#x53f0; 這種東西
 *   ② 前面黏著一段 likes / comments / 帳號 / 日期的殼，那不是文案
 * 直接存進 DB 的後果：網頁上搜「披薩」搜不到（描述裡根本沒有中文），
 * 而且送去 LLM 抽店名時模型看到的是一堆 entity，多地點抽取會直接失準。
 *
 * 這支的邏輯與 tools/enrich_places.py 的 clean_caption() 對齊，
 * 差別只在這裡是「寫入前先清乾淨」，那裡是「讀出來再清一次」（歷史資料的保險）。
 */

/** 英文版 IG 殼：「583 likes, 23 comments - handle on March 26, 2026: "」 */
const IG_SHELL_EN =
  /^[ \t]*[\d.,]+\s*[KkMm]?\s*likes?\s*,\s*[\d.,]+\s*[KkMm]?\s*comments?\s*[-–—]\s*.{1,120}?\s+on\s+[A-Za-z]+\s+\d{1,2},\s*\d{4}\s*:\s*["“«]?/gm;

/** 繁中版 IG 殼：「583 個讚，23 則留言 - handle 於 2026 年 3 月 26 日：「」 */
const IG_SHELL_ZH =
  /^[ \t]*[\d.,]+\s*[KkMm]?\s*個讚\s*[，,]\s*[\d.,]+\s*[KkMm]?\s*則留言\s*[-–—]\s*.{1,120}?於\s*\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日\s*[：:]\s*[「"“]?/gm;

/** 文案結尾被平台補上的收尾引號（"." 或 」。） */
const IG_TAIL = /\s*["”»」]\s*\.?\s*$/;

/**
 * 解 HTML entity（含 &#x53f0; 這種 numeric 形式）。
 * 刻意不用 DOM（這支在 Route Handler / Node 端也會跑，沒有 document）。
 */
function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : _;
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : _;
    })
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    // &amp; 一定要最後解，否則 &amp;quot; 會被提早還原成 &quot; 再被上面吃掉
    .replace(/&amp;/g, "&");
}

/**
 * 把貼文描述還原成人看得懂的文案。
 *
 * 不做的事：不截斷、不刪 hashtag —— hashtag 常常帶地名（#屏東美食），
 * 是判斷 city / district 的重要線索，刪掉反而讓辨識變差。
 */
export function cleanCaption(text: string | null | undefined): string | null {
  if (!text) return text ?? null;

  let s = decodeEntities(text);
  s = s.replace(IG_SHELL_EN, "").replace(IG_SHELL_ZH, "");
  s = s.replace(IG_TAIL, "");

  // 存進 DB 的描述是「og:title 換行 og:description」，而 og:title 就是文案第一行，
  // 剝完殼之後同一句會連著出現兩次 → 把重複的第一行拿掉。
  const lines = s.split("\n");
  if (lines.length >= 2) {
    const head = lines[0].trim().replace(/[.… ]+$/, "");
    const next = lines[1].trim();
    if (head.length >= 6 && next.startsWith(head.slice(0, Math.min(head.length, 12)))) {
      lines.shift();
    }
  }

  return lines.join("\n").trim();
}

/** 行首的條列記號：1. / ① / 1️⃣ / ▍ / 其之一 */
const LIST_MARKER = /^[ \t]*(?:[1-9][.、．)）]|[①②③④⑤⑥⑦⑧⑨]|[1-9]️?⃣|▍|其之[一二三四五六七八九])\s*\S/;

/** 價錢：有價錢的條列通常是菜單不是店家清單 */
const PRICE_HINT = /(NT\$|NTD|\$\s?\d|💰|\d+\s*元)/i;

/** 台灣地址：縣市 + 區/鄉/鎮 + 路/街/巷/號 */
const TW_ADDRESS = /[市縣].{0,12}?[區鄉鎮市].{0,20}?[路街道段巷弄]?.{0,10}?\d+\s*號/;

/**
 * 這篇文案看起來像不像「一篇介紹很多家店」的清單型貼文。
 *
 * 只是給 LINE 回覆用的一句提示（真正拆幾家由 enrich 的 LLM 決定），
 * 所以刻意用便宜的字串規則、不呼叫任何模型 —— webhook 必須在 LINE 的
 * replyToken 時限內回完，不能在這裡等 LLM。
 *
 * 判準用「條列 3 次以上」而不是 2 次，而且刻意排掉兩種假清單
 *（實測 2026-08-31 拿 DB 裡 52 篇真實文案調出來的）：
 *   1. **有價錢的編號** ——「1️⃣脆皮鴨胸 NTD 890」是菜單，AILAV／留白這種單店文
 *      都長這樣，不排掉的話每一篇都會被誤報成清單。
 *   2. **只數 📍** —— 單店文很常「📍店名 📍IG 📍營業時間 📍地址 📍電話」連五個，
 *      所以 📍 不算數，改成數「看起來是地址的行」有幾行：
 *      一篇裡出現三個以上完整地址，才比較可能真的是三家店。
 *
 * 寧可漏報也不要誤報：漏報只是少一句提示，誤報是答應他「會拆成多筆」卻沒拆。
 */
export function looksLikeListPost(caption: string | null | undefined): boolean {
  if (!caption) return false;

  let numbered = 0;
  let addresses = 0;
  for (const line of caption.split("\n")) {
    if (LIST_MARKER.test(line) && !PRICE_HINT.test(line)) numbered++;
    if (TW_ADDRESS.test(line)) addresses++;
  }
  return numbered >= 3 || addresses >= 3;
}
