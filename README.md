# 📍 Travel Bookmark 旅遊收藏

家庭共享美食景點收藏平台 — 在 LINE 群組傳連結自動收藏，Ollama 本地 AI 自動辨識店名/地區，網頁即時瀏覽篩選。

## 架構總覽

```
LINE 群組傳連結
    ↓
Vercel webhook（即時存入 Supabase）
    ↓
Ollama enrich（每 2 分鐘，本地 AI 自動補齊店名/地區/分類）
    ↓
Next.js 網頁（瀏覽/篩選/編輯）
```

## 功能

### LINE Bot
- 在群組傳 IG / 小紅書 / YouTube / TikTok 連結 → 自動收藏
- 自動抓取 OG metadata（標題、描述、封面圖）
- 重複連結自動擋（同群組 URL unique constraint）
- 支援查詢：傳「高雄」列出該縣市所有收藏

### Ollama 自動 Enrich
- 每 2 分鐘掃描未處理的書籤
- 抓取完整 IG 頁面內容（不只 OG meta），提升辨識準確率
- 使用 `qwen2.5:3b` 本地模型，完全免費無額度限制
- 結構化 JSON 輸出（`format: json`），穩定可靠
- 自動提取：店名、縣市、行政區、分類
- Confidence 信心分數：低於 0.5 自動重試，低於 0.7 網頁提示確認
- 行政區抓不到時自動 fallback 到縣市名

### 網頁前端
- 手機優先設計，加到主畫面像 App 使用
- 篩選：縣市 → 區域 → 類型，搜尋名稱/標籤
- 編輯：手動修正店名、縣市、分類
- 🔄 重新辨識：一鍵清除讓 Ollama 重跑
- ⚠️ 低信心提示：自動辨識不確定時顯示警告
- ✅ 已造訪標記
- 🗑️ 刪除收藏

### 分類類型
🍽️ 餐廳 · ☕ 咖啡廳 · 🏞️ 景點 · 🍺 酒吧 · 🏨 住宿 · 🥐 烘焙 · 🍰 甜點 · 🏮 夜市

## 一鍵安裝

```bash
git clone https://github.com/platypus31/travel-bookmark.git
cd travel-bookmark
bash bootstrap.sh
```

Bootstrap 會自動：
1. 安裝 Node.js 依賴
2. 檢查/下載 Ollama 模型（qwen2.5:3b）
3. 建立 LaunchAgent 定時 enrich（每 2 分鐘）
4. 建立 `.env.local` 範本
5. 驗證所有元件

### 前提條件
- macOS（LaunchAgent 定時任務）
- Node.js 18+
- Ollama（`brew install ollama`）
- Vercel 帳號（前端部署）

## 專案結構

```
travel-bookmark/
├── src/
│   ├── app/
│   │   ├── page.tsx                  # 主頁面（SSR 書籤列表）
│   │   ├── api/line-webhook/route.ts # LINE Bot webhook
│   │   └── api/preview/route.ts      # URL 預覽 API
│   ├── components/
│   │   ├── ClientApp.tsx             # 書籤列表 + 篩選 + 編輯
│   │   ├── AddBookmark.tsx           # 手動新增收藏
│   │   ├── BookmarkCard.tsx          # 單一書籤卡片
│   │   └── FilterBar.tsx             # 篩選列
│   └── lib/
│       ├── types.ts                  # 型別 + 台灣縣市區域資料
│       └── utils.ts                  # 平台偵測、emoji helper
├── tools/
│   └── enrich.sh                     # Ollama 自動 enrich 腳本
├── bootstrap.sh                      # 一鍵安裝
├── logs/                             # enrich 日誌
└── .env.local                        # API keys（gitignore）
```

## 技術架構

| 層級 | 技術 | 說明 |
|------|------|------|
| 前端 | Next.js 16 + TypeScript + Tailwind CSS | 手機優先 |
| 部署 | Vercel | push 自動部署 |
| 資料庫 | Supabase (PostgreSQL) | 東京 ap-northeast-1 |
| LINE Bot | Messaging API + Webhook | 群組收藏 |
| AI Enrich | Ollama + qwen2.5:3b | 本地免費 |
| 定時任務 | macOS LaunchAgent | 每 2 分鐘 |

## 資料庫結構

```
bookmarks
├── id            UUID PK
├── group_id      FK → groups
├── created_by    FK → profiles
├── url           原始連結（group_id + url unique）
├── platform      instagram | xiaohongshu | youtube | tiktok | other
├── title         店名（Ollama 自動提取）
├── description   原始描述
├── image_url     封面圖
├── city          縣市（不帶市/縣後綴）
├── district      行政區（fallback 到縣市）
├── place_type    restaurant | cafe | bar | hotel | attraction | bakery | dessert | nightmarket | other
├── tags          TEXT[] 標籤
├── visited       是否去過
├── confidence    AI 辨識信心（0.0~1.0）
├── enriched_at   enrich 完成時間
└── created_at
```

## 環境變數

| 變數名 | 說明 |
|--------|------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase 專案 URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase 匿名金鑰 |
| `LINE_CHANNEL_SECRET` | LINE Bot Channel Secret |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Bot Access Token |
| `LINE_DEFAULT_GROUP_ID` | 預設群組 UUID |
| `LINE_DEFAULT_USER_ID` | 預設使用者 UUID |

## 換電腦完整步驟

### 1. 安裝前提軟體
```bash
# Homebrew
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Node.js（建議用 nvm）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
nvm install 22

# Ollama
brew install ollama
ollama serve   # 保持背景執行
```

### 2. Clone 並安裝
```bash
git clone https://github.com/platypus31/travel-bookmark.git
cd travel-bookmark
```

### 3. 一鍵啟動（含 .env.local 自動建立）
```bash
bash bootstrap.sh
```

### 4. 驗證
```bash
# enrich 正常運作
bash tools/enrich.sh
tail -f logs/enrich.log

# LaunchAgent 已載入
launchctl list | grep travel-bookmark

# 前端本地測試
npm run dev    # 開啟 http://localhost:3000
```

### 5. Vercel 部署（如需重新連結）
```bash
npm i -g vercel
vercel login
vercel link    # 選擇 existing project: travel-bookmark
vercel --prod
```

## 外部服務帳號

| 服務 | 用途 | 管理位置 |
|------|------|----------|
| **Supabase** | 資料庫 + Auth | https://supabase.com/dashboard/project/YOUR_SUPABASE_PROJECT_ID |
| **LINE Developers** | Bot + Webhook | https://developers.line.biz/console/ |
| **Vercel** | 前端部署 | https://vercel.com/dashboard |
| **GitHub** | 程式碼備份 | https://github.com/platypus31/travel-bookmark |

## 常用指令

```bash
npm run dev              # 本地開發
bash tools/enrich.sh     # 手動執行一次 enrich
tail -f logs/enrich.log  # 查看 enrich 日誌
vercel --prod            # 部署到 Vercel
```

## 移除

```bash
# 停止 enrich 定時任務
launchctl unload ~/Library/LaunchAgents/travel-bookmark.enrich.plist
rm ~/Library/LaunchAgents/travel-bookmark.enrich.plist

# 刪除專案
rm -rf ~/travel-bookmark
```

## 線上服務

- **網站**: https://travel-bookmark-sigma.vercel.app
- **GitHub**: https://github.com/platypus31/travel-bookmark
