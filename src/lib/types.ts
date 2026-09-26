export type Platform = "instagram" | "xiaohongshu" | "youtube" | "tiktok" | "googlemaps" | "other";
export type PlaceType = "restaurant" | "cafe" | "attraction" | "bar" | "hotel" | "bakery" | "dessert" | "nightmarket" | "shop" | "drinks" | "other";

export interface Bookmark {
  id: string;
  group_id: string;
  created_by: string;
  url: string;
  /**
   * 來源貼文網址。IG／小紅書「一篇介紹 8 家店」的清單貼文拆出來時，
   * 每一筆都填同一個值，網頁靠它群組顯示並連回原貼文。單店收藏為 null。
   * （欄位由 supabase/migrations/2026-08-31-add-source-url.sql 建立；
   *   還沒跑 migration 的資料庫讀回來會是 undefined，所以型別容許 null/undefined 兩種缺值。）
   */
  source_url?: string | null;
  platform: Platform;
  title: string | null;
  description: string | null;
  image_url: string | null;
  city: string | null;
  district: string | null;
  place_type: PlaceType | null;
  tags: string[];
  visited: boolean;
  confidence: number | null;
  enriched_at: string | null;
  created_at: string;
  /**
   * 最後編輯者。欄位由 supabase/migrations/2026-09-26-collab-history-lists.sql 建立；
   * 舊資料一律是 null（沒有人用網頁編輯過），前端遇到 null 就不顯示「最後編輯」那行。
   */
  updated_by?: string | null;
  /** 人工編輯時間；只有網頁端人工編輯會寫，DB trigger 靠它分辨人 vs 背景腳本。 */
  user_edited_at?: string | null;
}

export interface Profile {
  id: string;
  display_name: string;
  group_id: string | null;
  created_at: string;
}

export interface Group {
  id: string;
  name: string;
  invite_code: string;
  created_at: string;
}

/** 誰、何時、改了哪個欄位、舊值→新值。由 bookmarks 的 UPDATE trigger 自動寫入。 */
export interface BookmarkEdit {
  id: string;
  bookmark_id: string;
  editor_id: string | null;
  field: string;
  old_value: string | null;
  new_value: string | null;
  created_at: string;
}

/** 個人清單／分類：大 pool 共用，透過 ListItem 多對多掛載收藏，不複製資料。 */
export interface BookmarkList {
  id: string;
  group_id: string;
  created_by: string | null;
  name: string;
  created_at: string;
}

export interface ListItem {
  list_id: string;
  bookmark_id: string;
  added_by: string | null;
  added_at: string;
}

export type ListEditAction = "add" | "remove" | "rename";

export interface ListEdit {
  id: string;
  list_id: string;
  editor_id: string | null;
  action: ListEditAction;
  bookmark_id: string | null;
  detail: string | null;
  created_at: string;
}

/** list_group_members RPC 的回傳形狀（比 Profile 少 group_id，刻意不外洩）。 */
export interface GroupMember {
  id: string;
  display_name: string;
  created_at: string;
}

export const EDITABLE_FIELD_LABELS: Record<string, string> = {
  title: "名稱",
  description: "描述",
  city: "縣市",
  district: "區域",
  place_type: "類型",
  visited: "已造訪",
  tags: "標籤",
};

export const CITIES: Record<string, string[]> = {
  台北: ["中正區", "大同區", "中山區", "松山區", "大安區", "萬華區", "信義區", "士林區", "北投區", "內湖區", "南港區", "文山區"],
  新北: ["板橋區", "三重區", "中和區", "永和區", "新莊區", "新店區", "淡水區", "汐止區", "瑞芳區", "土城區", "蘆洲區", "樹林區"],
  桃園: ["桃園區", "中壢區", "大溪區", "楊梅區", "蘆竹區", "龜山區", "八德區", "平鎮區"],
  台中: ["中區", "東區", "南區", "西區", "北區", "北屯區", "西屯區", "南屯區", "豐原區", "大里區", "太平區", "霧峰區"],
  台南: ["中西區", "東區", "南區", "北區", "安平區", "安南區", "永康區", "歸仁區", "新化區", "善化區"],
  高雄: ["楠梓區", "左營區", "鼓山區", "三民區", "鹽埕區", "前金區", "新興區", "苓雅區", "前鎮區", "小港區", "鳳山區", "旗津區"],
  新竹: ["東區", "北區", "香山區", "竹北市", "竹東鎮", "新豐鄉", "湖口鄉"],
  嘉義: ["東區", "西區", "太保市", "朴子市", "民雄鄉", "大林鎮"],
  花蓮: ["花蓮市", "吉安鄉", "新城鄉", "壽豐鄉", "鳳林鎮", "瑞穗鄉"],
  台東: ["台東市", "卑南鄉", "太麻里鄉", "關山鎮", "成功鎮", "池上鄉"],
  宜蘭: ["宜蘭市", "羅東鎮", "蘇澳鎮", "頭城鎮", "礁溪鄉", "五結鄉"],
  屏東: ["屏東市", "潮州鎮", "東港鎮", "恆春鎮", "萬丹鄉", "長治鄉"],
  南投: ["南投市", "埔里鎮", "草屯鎮", "竹山鎮", "集集鎮", "魚池鄉"],
  彰化: ["彰化市", "員林市", "鹿港鎮", "和美鎮", "溪湖鎮", "田中鎮"],
  雲林: ["斗六市", "虎尾鎮", "斗南鎮", "西螺鎮", "北港鎮"],
  基隆: ["仁愛區", "信義區", "中正區", "中山區", "安樂區", "暖暖區", "七堵區"],
  澎湖: ["馬公市", "湖西鄉", "白沙鄉", "西嶼鄉"],
};

export const PLACE_TYPE_LABELS: Record<PlaceType, string> = {
  restaurant: "餐廳",
  cafe: "咖啡廳",
  attraction: "景點",
  bar: "酒吧",
  hotel: "住宿",
  bakery: "烘焙",
  dessert: "甜點",
  nightmarket: "市集",
  shop: "商店",
  drinks: "手搖飲",
  other: "其他",
};

export const PLATFORM_LABELS: Record<Platform, string> = {
  instagram: "Instagram",
  xiaohongshu: "小紅書",
  youtube: "YouTube",
  tiktok: "TikTok",
  googlemaps: "Google Maps",
  other: "其他",
};
