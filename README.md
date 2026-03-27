# 📍 Travel Bookmark 旅遊收藏

家庭共享美食景點收藏平台 — 收藏 IG / 小紅書 / YouTube 推薦，依地區快速篩選餐廳景點。

## 功能

- **Email Magic Link 登入** — 免密碼，收信點連結即可登入
- **群組共享** — 建立群組，分享邀請碼給家人朋友，一起收藏
- **收藏連結** — 貼上 Instagram / 小紅書 / YouTube / TikTok 連結，自動偵測平台
- **地點標記** — 標記縣市、區域、類型（餐廳/咖啡廳/景點/酒吧/住宿）
- **標籤系統** — 自訂標籤（日式、海鮮、約會...）
- **篩選過濾** — 選縣市 → 區域，一鍵找出當地推薦
- **已造訪標記** — 打勾去過的地方
- **PWA 支援** — 加到手機主畫面，像 App 一樣使用
- **深色模式** — 自動跟隨系統設定

## 技術架構

| 層級 | 技術 | 說明 |
|------|------|------|
| 前端 | Next.js 16 + TypeScript + Tailwind CSS | 手機優先 PWA |
| 部署 | Vercel | 自動部署，免費方案 |
| 資料庫 | Supabase (PostgreSQL) | 區域：東京 ap-northeast-1 |
| 認證 | Supabase Auth (Magic Link) | Email OTP 登入 |
| 權限 | Supabase RLS | Row Level Security，群組隔離 |

## 專案結構

```
src/
├── app/
│   ├── layout.tsx          # 根 layout，PWA meta
│   ├── page.tsx            # 主頁面（認證 + 書籤列表 + 篩選）
│   └── globals.css         # Tailwind + 主題變數
├── components/
│   ├── AuthForm.tsx        # Email 登入表單
│   ├── SetupProfile.tsx    # 初次登入設定暱稱 + 建立/加入群組
│   ├── AddBookmark.tsx     # 新增收藏 modal
│   ├── BookmarkCard.tsx    # 單一收藏卡片
│   ├── FilterBar.tsx       # 縣市/區域/類型篩選列
│   └── GroupInfo.tsx       # 群組資訊 + 邀請碼 modal
└── lib/
    ├── supabase.ts         # Supabase client 初始化
    ├── types.ts            # TypeScript 型別 + 台灣縣市區域資料
    └── utils.ts            # 平台偵測、emoji helper
```

## 資料庫結構

```
groups          — 群組（家庭/朋友圈）
├── id          UUID PK
├── name        群組名稱
├── invite_code 邀請碼（8 字元）
└── created_at

profiles        — 使用者個人資料
├── id          UUID PK (= auth.users.id)
├── display_name 暱稱
├── group_id    FK → groups
└── created_at

bookmarks       — 收藏書籤
├── id          UUID PK
├── group_id    FK → groups
├── created_by  FK → profiles
├── url         原始連結
├── platform    instagram | xiaohongshu | youtube | tiktok | other
├── title       標題/店名
├── description 描述
├── image_url   封面圖
├── city        縣市
├── district    區域
├── place_type  restaurant | cafe | attraction | bar | hotel | other
├── tags        TEXT[] 標籤陣列
├── visited     是否去過
└── created_at
```

**RLS 策略**: 同群組成員可互相讀寫 bookmarks，個人 profile 只能自己修改。

## 本地開發

```bash
# 安裝依賴
npm install

# 設定環境變數
cp .env.local.example .env.local
# 填入 Supabase URL 和 Anon Key

# 啟動開發伺服器
npm run dev
```

開啟 http://localhost:3000

## 環境變數

| 變數名 | 說明 |
|--------|------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase 專案 URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase 匿名金鑰（公開安全，靠 RLS 保護） |

## 部署

已部署於 Vercel，push 到 `main` 後可用 `vercel --prod` 重新部署。

```bash
vercel --prod
```

## 線上服務

- **網站**: https://travel-bookmark-sigma.vercel.app
- **Supabase Dashboard**: https://supabase.com/dashboard/project/YOUR_SUPABASE_PROJECT_ID
- **GitHub**: https://github.com/platypus31/travel-bookmark
