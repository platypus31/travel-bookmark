export type Platform = "instagram" | "xiaohongshu" | "youtube" | "tiktok" | "other";
export type PlaceType = "restaurant" | "cafe" | "attraction" | "bar" | "hotel" | "bakery" | "dessert" | "nightmarket" | "other";

export interface Bookmark {
  id: string;
  group_id: string;
  created_by: string;
  url: string;
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
  nightmarket: "夜市",
  other: "其他",
};

export const PLATFORM_LABELS: Record<Platform, string> = {
  instagram: "Instagram",
  xiaohongshu: "小紅書",
  youtube: "YouTube",
  tiktok: "TikTok",
  other: "其他",
};
