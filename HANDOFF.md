# Travel Bookmark — 交班清單

上次更新：2026-04-23（repo 轉 public，個資 wash，.env 改用 secret Gist 備份）

## 專案狀態：完整運行中

LINE Bot 收藏 + Ollama 自動辨識 + 網頁瀏覽篩選，全部獨立運行。

## 🆕 換電腦 SOP（2026-04-23 新）

repo 是 public 不含 `.env.local`。個人 credential 存在 **secret Gist**（不公開但知道 URL 可讀）。

```bash
# 1. 裝工具
brew install node ollama gh
gh auth login  # 登入你的 GitHub 帳號

# 2. clone repo
git clone https://github.com/platypus31/travel-bookmark.git
cd travel-bookmark

# 3. 從自己的 secret Gist 拉 .env.local
gh gist list --limit 100 | grep travel-bookmark       # 找 gist ID
gh gist view <GIST_ID> > .env.local                   # 拉回 .env.local
# （如果忘了 gist ID，去 https://gist.github.com/ 找）

# 4. 跑 bootstrap
ollama serve &
ollama pull qwen2.5:3b
bash bootstrap.sh   # 偵測到 .env.local 已存在會跳過互動設定

# 5. 本機測試
npm run dev
```

**更新 .env.local 後同步到 Gist**：
```bash
gh gist edit <GIST_ID> -f .env.local .env.local
```

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
- [ ] **更多平台** — Google Maps 連結、Facebook、部落格
- [ ] **地圖檢視** — 書籤顯示在地圖上（需經緯度）

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
