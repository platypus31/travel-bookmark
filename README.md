# 📍 Travel Bookmark 旅遊收藏機器人

> 在 LINE 群組丟美食/景點連結，AI 自動幫你整理店名、地區、分類，網頁一鍵瀏覽。

跟家人朋友開一個 LINE 群組，平常看到好吃的餐廳就丟 IG / 小紅書的連結進去，機器人會自動：

✅ 存進雲端資料庫（永不遺失）
✅ 用 AI 讀懂內容，自動填好店名、縣市、分類（🍽️ 餐廳 / ☕ 咖啡廳 / 🏞️ 景點 / 🍺 酒吧 / ...）
✅ 在手機友善的網頁上顯示，可以篩選「高雄 → 左營 → 咖啡廳」
✅ 去過的打勾、沒去過的保留下次再試

**手機丟連結就好，不用打字、不用手動分類。**

---

## 🤖 最輕鬆路徑：讓 AI 當你的設定助手

不想讀長文？打開 [Claude.ai](https://claude.ai) 或 [ChatGPT](https://chat.openai.com)，照 [SETUP-WITH-AI.md](./SETUP-WITH-AI.md) 複製一段 prompt 貼進去，AI 會變成你的專屬 setup 助手：

✅ 一次只問你一步，等你做完才進下一步
✅ 貼給你該點的連結 + 要複製哪個欄位
✅ 收到你給的值（Supabase URL / LINE token）自動記錄
✅ 最後彙整成 6 個環境變數 copy-paste 包
✅ 卡住就貼錯誤訊息給 AI，自動診斷

**👉 看 [SETUP-WITH-AI.md](./SETUP-WITH-AI.md) 複製 prompt**

---

## 🚀 或自己動手：一鍵部署（3 分鐘）

### 第 1 步：部署到 Vercel

點這個按鈕，Vercel 會引導你 fork 專案 + 自動部署：

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/platypus31/travel-bookmark&env=NEXT_PUBLIC_SUPABASE_URL,NEXT_PUBLIC_SUPABASE_ANON_KEY,LINE_CHANNEL_SECRET,LINE_CHANNEL_ACCESS_TOKEN,LINE_DEFAULT_GROUP_ID,LINE_DEFAULT_USER_ID&envDescription=照下面教學取得這6個值&project-name=travel-bookmark&repository-name=travel-bookmark)

> 按下去 Vercel 會要你填 6 個環境變數（看下面第 2 和 3 步怎麼拿到）。

### 第 2 步：建 Supabase 資料庫（拿 2 個變數）

1. 點 👉 [**建立新 Supabase 專案**](https://supabase.com/dashboard/new/_/new-project)
2. 設定：Name: `travel-bookmark` / Region: `Tokyo` / Plan: `Free`
3. 等 2 分鐘建好後，點左邊 **SQL Editor** → **New query** → 把 [supabase-schema.sql](./supabase-schema.sql) 全文貼上 → **Run**
4. 點左邊 **Project Settings** → **API**，複製：
   - `Project URL` → 填 Vercel 的 `NEXT_PUBLIC_SUPABASE_URL`
   - `anon public` key → 填 Vercel 的 `NEXT_PUBLIC_SUPABASE_ANON_KEY`

另外 `LINE_DEFAULT_GROUP_ID` 和 `LINE_DEFAULT_USER_ID` 直接填：
```
LINE_DEFAULT_GROUP_ID = 00000000-0000-0000-0000-000000000001
LINE_DEFAULT_USER_ID  = 00000000-0000-0000-0000-000000000002
```

### 第 3 步：建 LINE Bot（拿 2 個變數）

1. 點 👉 [**LINE Developers Console**](https://developers.line.biz/console/) 登入
2. **Create a new provider**（第一次用）→ 名字隨便取（例如「我的 Bot」）
3. **Create a Messaging API channel**
4. 建好後：
   - **Basic settings** 頁最下 → 複製 `Channel secret` → 填 Vercel 的 `LINE_CHANNEL_SECRET`
   - **Messaging API** 頁往下滑 → 點 `Issue` 發行 `Channel access token` → 複製 → 填 Vercel 的 `LINE_CHANNEL_ACCESS_TOKEN`

**Vercel 6 個變數填完後按 Deploy，等 2 分鐘部署完。**

### 第 4 步：把 Vercel 網址填回 LINE Bot

1. Vercel 部署完會給你一個網址，例如 `https://travel-bookmark-xxx.vercel.app`
2. 回到 LINE Developers Console → 你的 Bot → **Messaging API** → **Webhook URL**
3. 貼上：`https://travel-bookmark-xxx.vercel.app/api/line-webhook`
4. 按 **Verify** → 看到 Success
5. **Use webhook** 打開 ✅
6. 往下 **Auto-reply messages** → 關掉（不然 Bot 會自動回罐頭訊息）

### 第 5 步：把 Bot 加進 LINE 群組

1. LINE Developers Console → **Messaging API** 頁 → 掃 **QR code** 加 Bot 好友
2. 設定裡開啟 **Allow bot to join group chats**
3. 開一個 LINE 群組 → 把 Bot 邀進來

### 第 6 步：在本機跑 AI 整理

AI 辨識店名要在你的 Mac 跑（免費，不用額度）：

```bash
# 1. 裝需要的工具（第一次才要）
brew install node ollama
ollama serve &
ollama pull qwen2.5:3b

# 2. 下載程式碼 + 一鍵設定
git clone https://github.com/你的GitHub帳號/travel-bookmark.git
cd travel-bookmark
bash bootstrap.sh
```

`bootstrap.sh` 會引導你填入 6 個環境變數（跟 Vercel 一樣的值），自動：
- 建立 `.env.local`
- 安裝套件
- 設定每 2 分鐘跑一次 AI 整理（LaunchAgent）

### 第 7 步：測試

打開 LINE 群組，丟一個 IG 連結：

```
https://www.instagram.com/p/xxxxx/
```

等 5 秒 → 刷新 Vercel 網址 → 應該看到這筆。
等 2 分鐘（AI 整理）→ 刷新 → 店名 / 縣市 / 分類自動填好。

✅ **完成！開始用 LINE 群組收藏美食景點吧。**

---

## 🎬 這個東西適合誰？

- **跟家人共享口袋名單**：爸媽看到 IG 美食想存起來下次去，不用另外用 Google Keep / Notion
- **朋友旅遊規劃**：大家把想去的餐廳丟進 LINE 群組，自動彙整出旅遊手冊
- **個人備忘**：自己看到什麼店想試試，直接丟給自己用的 LINE Bot 就存起來

---

## 🗺️ 怎麼運作的（架構圖）

```
   你在 LINE 丟連結（IG / 小紅書 / TikTok / YouTube）
              ↓
        LINE Bot 收到
              ↓
      Vercel 上的小程式（webhook）
              ↓
      存進 Supabase 資料庫
              ↓
  每 2 分鐘，Mac 本機 AI（Ollama + qwen2.5:3b）讀標題
    幫你填好：店名、縣市、區域、分類
              ↓
      打開網頁，看整理好的收藏
```

**三個免費服務 + 一台 Mac**，全部不用付錢。

---

## 🌐 重要網址（一鍵直達）

| 要做什麼 | 直達連結 |
|---|---|
| 🚀 部署到 Vercel | [一鍵 Deploy](https://vercel.com/new/clone?repository-url=https://github.com/platypus31/travel-bookmark) |
| 🗄️ 建 Supabase 資料庫 | [一鍵 New Project](https://supabase.com/dashboard/new/_/new-project) |
| 🤖 建 LINE Bot | [LINE Developers Console](https://developers.line.biz/console/) |
| 📊 管理 Supabase | [Supabase Dashboard](https://supabase.com/dashboard) |
| 🌍 管理 Vercel | [Vercel Dashboard](https://vercel.com/dashboard) |
| 📖 LINE Messaging API 文件 | [官方文件](https://developers.line.biz/zh-hant/docs/messaging-api/) |
| 📖 Next.js 說明 | [Next.js 文件](https://nextjs.org/docs) |
| 📖 Supabase 說明 | [Supabase 文件](https://supabase.com/docs) |
| 💻 本專案 GitHub | [platypus31/travel-bookmark](https://github.com/platypus31/travel-bookmark) |

---

## ❓ 常見問題 (FAQ)

### Q1：我完全不懂終端機，還能設定嗎？
第 1~5 步是純網頁點按鈕，國中生也會。只有第 6 步（本機跑 AI）需要打幾行指令，建議找熟電腦的朋友幫一次，之後每天用只是在 LINE 丟連結。

最輕鬆的路是頂部那個「讓 AI 當設定助手」— 貼 prompt 到 Claude.ai，AI 會逐步帶你，卡住就貼錯誤訊息給它診斷。

### Q2：一定要 Mac 嗎？
**Vercel + LINE + Supabase 部分不用**（純網路服務，手機也能管）。只有「本機 AI 整理」部分（第 6 步）需要 Mac（用 LaunchAgent 每 2 分鐘跑）。

**不裝第 6 步也能用**，只是書籤不會自動填店名/分類，需要自己手動補。

### Q3：要付錢嗎？
全部免費：
- LINE Messaging API：每月 500 通免費（接收訊息不算）
- Supabase Free：500MB 資料庫（可存幾萬筆書籤）
- Vercel Free：個人專案免費
- Ollama：本機跑，完全免費

### Q4：我的資料安全嗎？
- 資料存你自己的 Supabase（非第三方）
- LINE Bot token 只有你知道
- GitHub 上的程式碼**不含**任何 token（`.env.local` 被 `.gitignore` 排除）

### Q5：Ollama 要一直開著嗎？
`ollama serve` 要在背景執行才能自動整理書籤。可以設定成 Mac 開機自動跑（`brew services start ollama`）。

不想開也行 — LINE 丟的連結會停在「未處理」，下次開 Ollama 時會自動補上。

### Q6：LINE 丟連結沒反應怎麼辦？
1. 檢查 Webhook URL 對不對（第 4 步）
2. 點 Verify 看有沒有 Success
3. 檢查 Use webhook 是否開啟
4. 看 Vercel Logs：Vercel Dashboard → 你的專案 → Logs

### Q7：AI 辨識錯店名怎麼辦？
- 網頁上每張卡片都有 **🔄 重新辨識** 按鈕，按了清除讓 Ollama 重跑
- 也可以手動點 **編輯** 改店名/縣市/分類

### Q8：想停掉機器人？
```bash
# 停止每 2 分鐘的 AI 整理
launchctl unload ~/Library/LaunchAgents/travel-bookmark.enrich.plist
rm ~/Library/LaunchAgents/travel-bookmark.enrich.plist

# 停 LINE Bot：LINE Developers Console → Use webhook → 關掉
# 停 Vercel：Vercel Dashboard → 專案 → Settings → Delete Project
```

### Q9：fork 後 Vercel 找不到 repo？
Vercel 只會掃你登入的 GitHub 帳號下的 repo。先到 https://github.com/platypus31/travel-bookmark 右上角按 **Fork** 複製一份到你自己名下，再到 Vercel 就看得到了。

### Q10：想改介面/功能？
程式碼全部開源（MIT 授權），fork 後隨便改。主要檔案：
- `src/app/page.tsx` — 主頁面
- `src/components/` — UI 元件
- `src/app/api/line-webhook/route.ts` — LINE Bot 邏輯
- `tools/enrich.sh` — AI 整理腳本

---

## 🔧 技術架構（給開發者看的）

| 層級 | 技術 | 說明 |
|---|---|---|
| 前端 | Next.js 16 + TypeScript + Tailwind | 手機優先 SSR |
| 部署 | Vercel | GitHub push 自動部署 |
| 資料庫 | Supabase (PostgreSQL) | 東京 ap-northeast-1 |
| LINE Bot | Messaging API + Webhook | 群組自動收藏 |
| AI Enrich | Ollama + qwen2.5:3b | 本機免費，`format: json` 結構化輸出 |
| 定時任務 | macOS LaunchAgent | 每 2 分鐘掃未處理 |

### 專案結構
```
travel-bookmark/
├── src/
│   ├── app/
│   │   ├── page.tsx                  # 主頁（SSR 書籤列表）
│   │   ├── api/line-webhook/route.ts # LINE Bot webhook
│   │   └── api/preview/route.ts      # URL metadata 預覽
│   ├── components/
│   │   ├── ClientApp.tsx             # 書籤列表 + 篩選 + 編輯
│   │   ├── AddBookmark.tsx
│   │   ├── BookmarkCard.tsx
│   │   └── FilterBar.tsx
│   └── lib/
│       ├── types.ts
│       └── utils.ts
├── tools/
│   └── enrich.sh                     # Ollama 自動 enrich
├── bootstrap.sh                      # 互動式一鍵安裝
├── supabase-schema.sql               # 一鍵建表 SQL
└── .env.local                        # API keys（gitignore 排除）
```

### 環境變數對照
| 變數名 | 來源 |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Project Settings → API |
| `LINE_CHANNEL_SECRET` | LINE Dev Console → Basic settings |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Dev Console → Messaging API |
| `LINE_DEFAULT_GROUP_ID` | 固定 `00000000-0000-0000-0000-000000000001` |
| `LINE_DEFAULT_USER_ID` | 固定 `00000000-0000-0000-0000-000000000002` |

### 常用指令
```bash
npm run dev              # 本地開發 (http://localhost:3000)
bash tools/enrich.sh     # 手動跑一次 AI 整理
tail -f logs/enrich.log  # 看 AI 整理的 log
vercel --prod            # 手動部署到 Vercel
```

### 資料庫結構
```
bookmarks
├── id            UUID PK
├── group_id      FK → groups
├── created_by    FK → profiles
├── url           原始連結（group_id + url unique）
├── platform      instagram | xiaohongshu | youtube | tiktok | other
├── title         店名（Ollama 提取）
├── description   原始描述
├── image_url     封面圖
├── city          縣市（不帶市/縣後綴）
├── district      行政區（fallback 到縣市）
├── place_type    restaurant | cafe | bar | hotel | attraction |
│                 bakery | dessert | nightmarket | other
├── tags          TEXT[]
├── visited       是否去過
├── confidence    AI 辨識信心（0.0~1.0）
├── enriched_at   enrich 完成時間
└── created_at
```

### 分類類型
🍽️ 餐廳 · ☕ 咖啡廳 · 🏞️ 景點 · 🍺 酒吧 · 🏨 住宿 · 🥐 烘焙 · 🍰 甜點 · 🏮 夜市

---

## 📬 Feedback / Issues

這是個人專案，歡迎 fork 改造。有問題開 GitHub Issue：
https://github.com/platypus31/travel-bookmark/issues

---

## 📄 授權

MIT — 自由使用、修改、分享。
