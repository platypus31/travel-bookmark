# Travel Bookmark — 交班清單

上次更新：2026-03-28

## 專案狀態：MVP 已上線

網站已部署到 Vercel，可正常使用。核心的收藏、篩選、群組共享功能已完成。

## 帳號與服務

| 服務 | 詳情 |
|------|------|
| GitHub | `platypus31/travel-bookmark` (private repo) |
| Vercel | 專案 `travel-bookmark`，帳號 `YOUR_VERCEL_TEAM` |
| Supabase | 專案 ID: `YOUR_SUPABASE_PROJECT_ID`，組織: `platypus31's Org`，區域: `ap-northeast-1` |
| 網站 URL | https://travel-bookmark-sigma.vercel.app |

## 已完成

- [x] GitHub repo 建立 (private)
- [x] Next.js 16 + TypeScript + Tailwind CSS 專案初始化
- [x] Supabase 專案建立（東京區域，免費方案）
- [x] 資料庫結構：groups, profiles, bookmarks 三張表
- [x] RLS 安全策略：群組隔離
- [x] Email Magic Link 認證
- [x] 初次登入流程：設定暱稱 → 建立/加入群組
- [x] 新增收藏功能（貼連結、選地點、標籤）
- [x] 平台自動偵測（IG/小紅書/YouTube/TikTok）
- [x] 台灣縣市區域篩選器
- [x] 收藏卡片列表 + 已造訪標記
- [x] 群組邀請碼分享
- [x] PWA manifest
- [x] 深色模式
- [x] Vercel 部署 + 環境變數設定

## 待完成（優先順序）

### P0 — 必須做
- [ ] **Supabase Auth Redirect URL 設定** — 到 Supabase Dashboard → Authentication → URL Configuration，加入 `https://travel-bookmark-sigma.vercel.app` 到 Redirect URLs，否則 Magic Link 登入會失敗
- [ ] **PWA icon** — 目前 `manifest.json` 指向 `/icon-192.png` 和 `/icon-512.png`，需要放入 `public/` 資料夾

### P1 — 重要功能
- [ ] **刪除收藏** — 目前只能新增和編輯，沒有刪除 UI
- [ ] **編輯收藏** — 點擊卡片可以編輯標題、地點、標籤
- [ ] **URL 預覽抓取** — 貼上連結後自動抓取標題和封面圖（需要 API Route + OG meta 爬取）
- [ ] **排序功能** — 依時間、地區、類型排序
- [ ] **搜尋優化** — 目前是前端 filter，資料量大時應改為 Supabase query

### P2 — 加分功能
- [ ] **Google Maps 整合** — 書籤地點顯示在地圖上
- [ ] **分享連結** — 一鍵分享收藏清單給非群組用戶（唯讀）
- [ ] **圖片上傳** — 用 Supabase Storage 或 Vercel Blob 上傳自己的照片
- [ ] **多群組支援** — 一個用戶可以加入多個群組
- [ ] **通知** — 家人新增收藏時推送通知
- [ ] **匯出** — 匯出為 Google Maps 清單或 CSV

### P3 — 優化
- [ ] **Loading skeleton** — 載入中顯示骨架畫面
- [ ] **Optimistic update** — 操作後立即更新 UI 不等 API
- [ ] **Error boundary** — 錯誤處理 UI
- [ ] **i18n** — 多語言支援（目前只有中文）

## 開發指令

```bash
npm run dev        # 開發伺服器 http://localhost:3000
npm run build      # 建構
npm run lint       # ESLint
vercel --prod      # 部署到 Vercel production
```

## 關鍵檔案快速導覽

| 要改什麼 | 看哪個檔案 |
|---------|-----------|
| 主頁面邏輯（認證流程、書籤載入、篩選） | `src/app/page.tsx` |
| 新增收藏的表單 | `src/components/AddBookmark.tsx` |
| 收藏卡片外觀 | `src/components/BookmarkCard.tsx` |
| 篩選器 UI | `src/components/FilterBar.tsx` |
| 台灣縣市區域資料 | `src/lib/types.ts` → `CITIES` |
| 平台偵測邏輯 | `src/lib/utils.ts` → `detectPlatform()` |
| Supabase 連線 | `src/lib/supabase.ts` |
| 環境變數 | `.env.local`（本地）/ Vercel Dashboard（線上） |
| 資料庫結構 | 本文件「已完成」段落 / Supabase Dashboard |

## 注意事項

- `.env.local` 在 `.gitignore` 中，不會上傳到 GitHub
- Vercel 環境變數已設定 `NEXT_PUBLIC_SUPABASE_URL` 和 `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- Supabase anon key 是公開金鑰，安全靠 RLS 保護，不是 secret
- 資料庫 RLS 已啟用，確保只有同群組成員能互相看到收藏
- GitHub repo 目前沒有連接 Vercel Git Integration（需要手動 `vercel --prod` 部署）
