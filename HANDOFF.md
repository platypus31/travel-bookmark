# Travel Bookmark — 交班清單

上次更新：2026-08-31（新增 Google Maps 分享連結收錄）

## 專案狀態：完整運行中

LINE Bot 收藏 + Ollama 自動辨識 + 網頁瀏覽篩選，全部獨立運行。

## 🆕 換電腦 SOP（2026-04-23 新）

repo 是 public 不含 `.env.local`。個人 credential 存在 **secret Gist**（不公開但知道 URL 可讀）。

**4 行無腦換電腦**：
```bash
brew install node ollama gh
gh auth login                                                    # 登入你的 GitHub
git clone https://github.com/platypus31/travel-bookmark.git && cd travel-bookmark
bash scripts/restore-env.sh                                      # 自動拉 .env.local
bash bootstrap.sh                                                # 偵測到 .env.local 會跳過互動
```

`scripts/restore-env.sh` 自動：
- 確認 gh CLI 已登入
- `gh gist list | grep travel-bookmark` 找 gist ID
- 備份現有 `.env.local`（如果有）
- 拉 gist 內容到 `.env.local`
- 顯示變數清單（不顯示值）確認成功

**備份 .env.local 到 Gist（首次 / 更新 token 後）**：
```bash
bash scripts/backup-env.sh
```

`scripts/backup-env.sh` 自動：
- 檢查 `.env.local` 不是 placeholder
- 找既有 gist → 有就更新，沒有就建新 secret gist
- 印出 gist URL

**依賴**：只需 `gh` CLI + GitHub 帳號。Gist 自動跟著 GitHub 帳號走。

## 架構

```
LINE 群組傳連結 → Vercel webhook（即時存入 Supabase + 抓 og:image）
                         ↓
              Ollama enrich（每 2 分鐘，本地 AI 補齊店名/地區/分類）
                         ↓
              Next.js 網頁（瀏覽/篩選/編輯/Google Maps 連結）
```

## 帳號與服務

| 服務 | 詳情 |
|------|------|
| GitHub | `platypus31/travel-bookmark` (private repo) |
| Vercel | 專案 `travel-bookmark`，帳號 `YOUR_VERCEL_TEAM` |
| Supabase | 專案 ID: `YOUR_SUPABASE_PROJECT_ID`，區域: `ap-northeast-1` |
| 網站 URL | https://travel-bookmark-sigma.vercel.app |
| LINE Bot | Channel Secret + Access Token 在 bootstrap.sh 內 |
| Ollama 模型 | qwen2.5:3b（本地免費） |

## 已完成

- [x] LINE Bot webhook（Vercel serverless）
- [x] Ollama enrich v2（完整頁面抓取 + structured JSON + confidence）
- [x] 小紅書支援（短連結展開 + `__INITIAL_STATE__` 解析）
- [x] Google Maps 分享連結收錄（短網址展開 + 從 URL 解出店名/座標，`src/lib/gmaps.ts`）
      **為什麼不接 Google Places API**（2026-08-31 判斷，之後想加請先讀這段）：
      不需要。要的東西網址本身就給了 —— `/maps/place/店名/@緯度,經度`，
      短網址一次 302 就展開。實測 Maps 頁面 `og:title` 恆為 "Google Maps"、
      `og:description` 恆為 "Find local businesses..."、地址是 JS 才渲染，
      所以「抓網頁 meta」對 Maps 完全無效，這也是為何 Maps 不走 `fetchOgMeta`。
      接 Places API 要金鑰、要綁信用卡、有配額、多一個外部故障點，
      為了已經拿得到的東西付費不划算。
      **代價（誠實記錄）**：拿不到門牌地址與營業資訊，縣市/行政區交給後段 LLM 從店名推斷；
      若哪天真的需要「地址、電話、營業時間、評分」，那才是接 Places API 的時機。
      🔴 **需要使用者跑一次 SQL 才會生效** → `supabase/migrations/2026-08-31-add-googlemaps-platform.sql`
      （線上 DB 的 `bookmarks_platform_check` 沒放行 `googlemaps`，實測插入回 400/23514）
- [x] 防幻覺（低信心不更新 title、prompt 明確禁止猜測）
- [x] 書籤分類：餐廳/咖啡廳/景點/酒吧/住宿/烘焙/甜點/夜市
- [x] 網頁篩選（縣市→區域→類型→搜尋）
- [x] 編輯/刪除/已造訪標記
- [x] 🔄 重新辨識按鈕
- [x] 📍 Google Maps 搜尋連結
- [x] ⚠️ 低信心提示 / 🔄 等待辨識提示
- [x] URL 去重（同群組同 URL unique constraint）
- [x] District fallback（抓不到行政區自動填縣市）
- [x] bootstrap.sh 一鍵安裝（含 .env.local）
- [x] README 完整說明書
- [x] Supabase Storage bucket（bookmark-images，已建但暫未使用）

## 已知問題

1. **Vercel 自動部署被 Hobby 方案擋** — 用 prebuilt 部署繞過：
   ```bash
   vercel pull --yes --environment production
   vercel build --prod
   vercel deploy --prebuilt --prod --yes
   ```
2. **IG 封面圖 CDN URL 過期（403）** — 已移除前端圖片顯示，Supabase Storage bucket 已建好，未來可存永久圖片
3. **小紅書封面圖抓不到** — 頁面 JS 渲染，og:image 為空
4. **git config** — repo 已設 `user.email=platypusbot@users.noreply.github.com`、`user.name=platypus31`，不要改
5. **schema drift（2026-08-31 發現）** — 線上 DB 有 `bookmarks_platform_check` 這個 CHECK constraint，
   但 `supabase-schema.sql` 裡從來沒有。已補寫進 schema 檔。
   **教訓：以後加新的 platform / place_type 值，光改 TypeScript union 不夠，要一起改 DB constraint。**

## 待優化（優先順序）

### P1 — 值得做
- [ ] **封面圖永久化** — enrich 時下載圖片存到 Supabase Storage，替換過期 CDN URL
- [ ] **LINE 推播 enrich 結果** — enrich 完成後用 Push API 告訴用戶正確店名
- [ ] **Webhook 觸發 enrich** — 存入後直接觸發，不用等 2 分鐘 polling
- [ ] **編輯 district + tags** — 前端目前只能編輯 title/city/type

### P2 — 加分
- [ ] **匯出 Google Maps 清單** — 匯出成 KML 或 CSV
- [ ] **分享連結** — 一鍵分享收藏清單（唯讀）
- [ ] **排序功能** — 依時間、地區、類型排序
- [ ] **Loading skeleton** — 載入骨架畫面

### P3 — 長期
- [ ] **IG Graph API** — 抓留言（置頂留言有店家資訊），需 Facebook App 審核
- [ ] **更多平台** — Facebook、部落格（Google Maps 已於 2026-08-31 完成）
- [ ] **地圖檢視** — 書籤顯示在地圖上（需經緯度）
      ⚠️ Google Maps 連結「解得出」經緯度但**目前沒有存進 DB**：
      `bookmarks` 表沒有 lat/lng 欄位，加欄位要動線上 DB（migration），本次刻意不做。
      座標目前保留在收藏的網址裡（`/@lat,lng`），要做地圖檢視時再一起加欄位 + 回填。

## 關鍵檔案

| 要改什麼 | 看哪個檔案 |
|---------|-----------|
| 主頁面 + 書籤列表 + 篩選 | `src/components/ClientApp.tsx` |
| SSR 資料載入 | `src/app/page.tsx` |
| LINE webhook | `src/app/api/line-webhook/route.ts` |
| Ollama enrich 腳本 | `tools/enrich.sh` |
| 一鍵安裝 | `bootstrap.sh` |
| 型別 + 縣市區域資料 | `src/lib/types.ts` |
| 平台偵測 + emoji | `src/lib/utils.ts` |
| Google Maps 網址解析 | `src/lib/gmaps.ts` |
| DB schema | README.md「資料庫結構」段落 |

## 部署指令

```bash
# 本地開發
npm run dev

# 部署到 Vercel（必須用 prebuilt，不能用 git auto-deploy）
vercel pull --yes --environment production
vercel build --prod
vercel deploy --prebuilt --prod --yes

# 手動執行一次 enrich
bash tools/enrich.sh

# 查看 enrich 日誌
tail -f logs/enrich.log
```

## 注意事項

- `.env.local` 在 `.gitignore` 中，但 keys 已內嵌在 `bootstrap.sh`（私人 repo）
- Vercel 環境變數已設定（LINE + Supabase）
- Supabase anon key 是公開金鑰，安全靠 RLS
- enrich 腳本由 LaunchAgent `travel-bookmark.enrich` 每 2 分鐘執行
- 這是獨立工具，不屬於 ai-twin 系統架構
