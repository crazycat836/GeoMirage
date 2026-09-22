# GeoMirage

在 macOS 或 Windows 上模擬 iPhone 的 GPS 位置。支援瞬移、沿道路導航、路線循環與搖桿操控，透過 USB 或 WiFi 連線。不修改 iPhone 的系統或使用者資料；清除虛擬定位或中斷連線後，iPhone 會回到真實 GPS。

<p align="center">
  <img src="frontend/build/icon.png" width="160" alt="GeoMirage">
</p>

<p align="center">
  <a href="https://github.com/crazycat836/GeoMirage/releases/latest">
    <img alt="最新版本" src="https://img.shields.io/github/v/release/crazycat836/GeoMirage?style=for-the-badge&color=2d3748">
  </a>
  <a href="LICENSE">
    <img alt="License" src="https://img.shields.io/badge/license-MIT-2d3748?style=for-the-badge">
  </a>
</p>

> ⚠️ **定位類遊戲使用者請注意**
> 多數定位類遊戲與社群平台禁止虛擬定位，使用本工具可能導致帳號被警告或停權。開發者不負責任何帳號損失，請自行評估。

---

## 目錄

- [功能](#功能)
- [系統需求](#系統需求)
- [安裝與啟動](#安裝與啟動)
- [第一次連線](#第一次連線)
- [疑難排解](#疑難排解)
- [資料與外部服務](#資料與外部服務)
- [開發](#開發)
- [License](#license)
- [免責聲明](#免責聲明)

---

## 功能

### 移動模式

底部模式列有四種模式，也可以用數字鍵 `1`～`4` 切換。

| 模式 | 說明 |
| --- | --- |
| **瞬移 Teleport** | 跳到指定座標。啟動前顯示依距離估算的冷卻時間；可開啟「自動抖動」 |
| **導航 Navigate** | 從目前位置沿 OSRM 規劃的道路移動到目的地 |
| **路線 Route** | 依序走過地圖上的路徑點並循環。可設定圈數（無限或 2～99 圈），每圈之間會隨機停頓 |
| **搖桿 Joystick** | 用 WASD／方向鍵或拖曳搖桿即時移動，可調整靈敏度 |

- **速度**：走路 10.8、跑步 19.8、開車 60 km/h。移動中切換速度會立即套用，從目前位置繼續。
- **預估時間**：導航與路線模式啟動前，依距離、速度與圈數顯示預估時間。
- **路線無法規劃時**：OSRM 找不到可行道路時，模擬會停止並顯示「路線規劃失敗」，不會改走直線。

### 路徑點與路線

- 路線模式下左鍵點地圖新增路徑點，或在右鍵選單選「新增路徑點」。
- 路徑點可拖曳重排，也可以隨機產生（指定半徑與數量）。
- 3 個以上路徑點時可「最佳化順序」，縮短總距離。
- 路線可存進路線庫，依分類管理、搜尋、排序、批次移動或刪除；支援 GPX 匯入／匯出，以及整個路線庫的 JSON 匯出／匯入。

### 收藏

- 以「地點」與「標籤」分類，可篩選、排序、多選、搬移，並顯示國旗。
- JSON 匯出／匯入。匯入的資料會加在現有收藏之後，不會覆蓋。
- 批次貼上座標，支援 `(lat, lng)`、全形括號，以及 Google Maps 網址中的 `@lat,lng,15z`，每行可附名稱。

### 地圖與搜尋

- **地址搜尋**：預設使用 Photon，可在設定改成 Nominatim，或填入自己的 Google Places API key。搜尋框也可以直接貼上 `緯度, 經度`。
- **右鍵選單**：這裡是哪裡、複製座標、瞬移或導航到此、加入收藏、新增路徑點、快速儲存路線。
- **目的地地址**：以 Nominatim 反查地址並顯示。
- **定位我的電腦**：用電腦的定位在地圖上標出位置，可選擇只移動地圖，或連 iPhone 一起瞬移過去。
- **地圖圖層**：OpenStreetMap（預設）、CARTO、Esri。
- **天氣**：顯示目前位置的天氣（open-meteo）。

### 連線

- **USB**：插上並信任後，在裝置清單按「連線」。拔線會被偵測到並中斷連線。
- **WiFi**：透過 WiFi Tunnel 連線。會先用 mDNS 找裝置，找不到時掃描同網段；成功的 IP 與 port 會記住。
- **USB 轉 WiFi**：已有 WiFi Tunnel 時拔掉 USB，會自動改用 WiFi 繼續。
- **雙裝置**：最多同時連兩台 iPhone，操作會同步送到兩台。雙裝置模式下不套用冷卻。
- **螢幕暗掉時維持 WiFi 連線**（設定中開啟）：閒置時定期重送目前位置，避免 iPhone 螢幕變暗後 Tunnel 中斷。

### 其他

- **清除虛擬定位**：讓 iPhone 回到真實 GPS（雙裝置時兩台一起）。
- **啟動位置**：設定開啟 app 時地圖的中心點，只影響地圖，不會送出定位。
- **記住上次位置**：後端每 2 秒記錄一次目前位置，下次開啟時直接顯示。
- **Gold Ditto**（Pikmin Bloom）：跳到設定好的位置後，自動恢復真實 GPS。
- **冷卻**：可在設定中開關，畫面上顯示剩餘時間。
- **地圖圖釘頭像**：可選內建圖示或上傳圖片。
- **介面語言**：繁體中文、English。
- **更新提醒**：啟動時檢查 GitHub 最新 release；選「稍後」會 6 小時內不再提示。

### 快捷鍵

| 按鍵 | 動作 |
| --- | --- |
| `1`～`4` | 切換瞬移／導航／路線／搖桿 |
| `Space` | 暫停／繼續 |
| `⌘/Ctrl + K` | 搜尋 |
| `⌘ + B` | 開啟收藏與路線庫 |
| `Esc` | 關閉收藏與路線庫 |
| `W A S D`／方向鍵 | 搖桿移動 |

---

## 系統需求

| 項目 | 需求 |
| --- | --- |
| 電腦 | macOS（Apple Silicon）或 Windows 10／11 |
| iPhone | iOS 16 以上，已開啟開發者模式（iOS 15 以下不支援） |
| Python | 3.13 |
| Node.js | 22.22 以上 |
| 權限 | iOS 17 以上需要以系統管理員／`sudo` 執行，USB 與 WiFi 都一樣 |
| Windows 另需 | [Apple 官網的 iTunes for Windows](https://www.apple.com/itunes/)（64-bit）。Microsoft Store 的「Apple Devices」不相容 |
| 網路 | 第一次連線 iOS 17 以上的裝置時，需要從 GitHub 下載開發者映像檔（約 15 MB） |

目前 GitHub Releases 沒有附上安裝檔，請從原始碼執行，或依[建置安裝檔](#建置安裝檔)自行打包。

---

## 安裝與啟動

```bash
git clone https://github.com/crazycat836/GeoMirage.git
cd GeoMirage

# 安裝依賴（不要用 sudo）
python3 -m pip install -r backend/requirements.txt
cd frontend && npm install && cd ..

# 讓瀏覽器版前端可以連到後端
cp .env.dev.example .env.dev
```

啟動：

```bash
# macOS
sudo python3 start.py --open

# Windows：以系統管理員身分開啟 PowerShell 後
python start.py --open
```

`start.py` 會啟動後端（`127.0.0.1:8777`）與前端（`http://127.0.0.1:5173`），`--open` 會自動開啟瀏覽器。停止時按 `Ctrl+C`，或執行 `python3 stop.py`。

`.env.dev` 裡的 `GEOMIRAGE_DEV_NOAUTH=1` 會關閉後端的 token 驗證，因為瀏覽器版前端無法取得 Electron 注入的 token。這台電腦上的任何瀏覽器分頁都能呼叫 API，不要在共用電腦上使用。

### 建置安裝檔

```bash
python3 build.py
```

依執行的平台產生安裝檔，輸出到 `frontend/release/`：

- Windows：NSIS 安裝檔
- macOS：`.dmg` 與 `.zip`（arm64）

macOS 安裝檔沒有經過 Apple 公證，第一次開啟會被擋；到「系統設定 → 隱私權與安全性」選擇仍要開啟。

macOS 版每次啟動會跳出系統的管理員密碼視窗，後端以管理員權限執行（iOS 17 以上的裝置通道需要）。按取消則以一般權限執行，只能連 iOS 16 以下的裝置。結束 app 後後端會自行關閉。

---

## 第一次連線

1. **信任電腦**：用 USB 接上 iPhone，在 iPhone 上點「信任」並輸入密碼。
2. **開啟開發者模式**（iOS 16 以上）：設定 → 隱私權與安全性 → 開發者模式 → 開啟，重新開機後確認。找不到這個選項時，用 USB 連線後在錯誤提示中按「顯示開發者模式」，或參考[附錄](#附錄開發者模式選項沒有出現)。
3. **連線**：在 GeoMirage 右上角開啟裝置清單，對 iPhone 按「連線」。
4. **準備開發者映像檔**（iOS 17 以上）：連線時會自動處理，畫面會顯示目前的步驟：
   - **步驟 1/2 下載**：只有第一次使用或 pymobiledevice3 更新後才需要。後端啟動時會先在背景下載，所以多數時候會直接跳到掛載。
   - **步驟 2/2 掛載**：約 10～30 秒，過程中請保持 iPhone 解鎖。
   - 失敗時，畫面上方會說明原因（網路、iPhone 鎖定、連線中斷或開發者模式關閉），處理後按「重試」即可，不用重新接線。
5. 在瞬移模式下點地圖上的一個位置，按底部的「瞬移」。

### 使用 WiFi

- iPhone 與電腦要在同一個網段，且 iPhone 必須先用 USB 完成信任。
- iPhone 螢幕鎖定會中斷 Tunnel。長時間使用時，把「設定 → 螢幕顯示與亮度 → 自動鎖定」設為「永不」，或在 GeoMirage 設定中開啟「螢幕暗掉時維持 WiFi 連線」。
- WiFi Tunnel 無法啟動時，用 USB 接上後在裝置清單按「重新配對」。

---

## 疑難排解

| 狀況 | 處理方式 |
| --- | --- |
| 畫面空白或一直連不到後端 | 確認 port 8777、5173 沒被其他程式佔用；瀏覽器版需要 `.env.dev` |
| iPhone 已接上但連線失敗 | 在 iPhone 上點「信任」；已經點過的話，拔掉重插 |
| iOS 17 以上連線失敗，提示需要系統管理員 | macOS 用 `sudo python3 start.py`；Windows 以系統管理員身分執行 |
| 開發者映像檔下載太久或失敗 | 公司或校園網路可能擋 `raw.githubusercontent.com`，改用手機熱點後按「重試」。下載逾時後會在背景繼續，稍後重試會直接用已下載的檔案 |
| 提示 iPhone 鎖定 | 解鎖 iPhone 後按「重試」 |
| 提示掛載途中連線中斷 | 確認 iPhone 已解鎖、USB 或 WiFi 正常，按「重試」 |
| 提示開發者模式已關閉 | 大版本 iOS 更新會把開發者模式關掉，重新開啟並重開機後按「重試」 |
| WiFi Tunnel 連上後不久就斷線 | iPhone 螢幕鎖定會中斷 Tunnel，見[使用 WiFi](#使用-wifi) |
| 導航或路線顯示「路線規劃失敗」 | 該路段 OSRM 規劃不出道路，換一個目的地或調整路徑點 |

回報問題請[開 Issue](https://github.com/crazycat836/GeoMirage/issues)，並附上 `backend.log`（設定 → Log 資料夾）。

### 附錄：開發者模式選項沒有出現

iOS 16 以上的「開發者模式」選項，要在裝置曾連接開發工具後才會出現。依序嘗試：

1. 用 USB 連線，在 GeoMirage 的錯誤提示中按「顯示開發者模式」，再到 iPhone 設定中找選項。
2. 仍然沒有出現時，用 [Sideloadly](https://sideloadly.io/) 側載任一個小型 IPA，再回到「設定 → 隱私權與安全性 → 開發者模式」。

---

## 資料與外部服務

### 本機資料（`~/.geomirage/`）

| 檔案 | 內容 |
| --- | --- |
| `settings.json` | 設定與上次位置 |
| `bookmarks.json` | 收藏、地點、標籤 |
| `routes.json` | 路線與分類 |
| `token` | 後端 session token（每次啟動重新產生） |
| `logs/backend.log` | 後端 log |
| `usage/usage-YYYY-MM.jsonl` | 介面操作紀錄（點擊的按鈕、開關的對話框、API 路徑與結果），只存在本機，不含座標與輸入內容，用來評估介面調整 |

開發者映像檔快取在 pymobiledevice3 的資料夾下的 `Xcode_iOS_DDI_Personalized/`（既有安裝為 `~/.pymobiledevice3/`，新安裝為 `~/.local/share/pymobiledevice3/`）。

### 會連線的外部服務

| 服務 | 用途 |
| --- | --- |
| OpenStreetMap／CARTO／Esri | 地圖圖磚 |
| OSRM（`router.project-osrm.org`） | 導航與路線規劃 |
| Photon／Nominatim／Google Places | 地址搜尋與反查；Google 只在填入自己的 key 時使用 |
| open-meteo | 天氣 |
| GitHub（`raw.githubusercontent.com`） | 下載開發者映像檔 |
| Apple 簽章伺服器 | 掛載開發者映像檔時的裝置簽章 |
| GitHub API | 檢查新版本 |

OSRM、Nominatim、Photon、Google Places 的網址可以用環境變數 `OSRM_BASE_URL`、`NOMINATIM_BASE_URL`、`PHOTON_BASE_URL`、`GOOGLE_PLACES_BASE_URL` 改成自架服務。

---

## 開發

<details>
<summary>架構、技術、指令（點擊展開）</summary>

### 架構

```
┌──────────────────────────┐   HTTP + WebSocket   ┌──────────────────────┐
│ React 前端                │ ───────────────────► │ FastAPI 後端          │
│ Vite :5173 或 Electron    │ ◄─────────────────── │ 127.0.0.1:8777        │
└──────────────────────────┘                      └──────────┬───────────┘
                                                             │ pymobiledevice3
                                                             ▼
                                                  ┌──────────────────────┐
                                                  │ iPhone（USB／WiFi）   │
                                                  └──────────────────────┘
```

| 層 | 技術 |
| --- | --- |
| 前端 | React 19、TypeScript 7、Vite 8、Tailwind CSS 4、Leaflet 1.9、Electron 44 |
| 後端 | Python 3.13、FastAPI、uvicorn、pydantic 2、pymobiledevice3 11.10 以上、httpx、gpxpy |
| 打包 | PyInstaller、electron-builder |

### 專案結構

```
GeoMirage/
├── backend/          # FastAPI + pymobiledevice3（api/ → core/ → services/）
├── frontend/         # React 前端與 Electron 殼（src/、electron/）
├── tools/            # 分層檢查、WS 型別產生、使用紀錄報表
├── start.py / stop.py
└── build.py
```

### 常用指令

```bash
# 開發：後端 + Vite（瀏覽器）
sudo python3 start.py --open
# 開發：Electron 殼（另外啟動後端）
cd frontend && npm start

# 測試與檢查
cd backend && python3 -m pytest tests
cd frontend && npm test
cd frontend && ./node_modules/.bin/tsc --noEmit -p tsconfig.json
python3 tools/check_layers.py        # 後端分層規則 api → core → services
python3 tools/gen_ws_types.py        # 改了 backend/models/ws_events.py 後重新產生前端型別

# 介面操作紀錄報表
python3 tools/usage_report.py --days 30
```

CI（`.github/workflows/ci.yml`）在 push 與 PR 到 `main` 時執行：分層檢查、WS 型別是否為最新、前端 tsc 與 vitest、後端 pytest。

### 發布

1. 更新 `frontend/package.json` 的 `version`
2. commit 到 `main`
3. `git tag vX.Y.Z && git push origin main --tags`
4. `gh release create vX.Y.Z`（要發布，不能是草稿，app 內的更新提醒才看得到）

Commit 採 [Conventional Commits](https://www.conventionalcommits.org/)。

</details>

---

## License

MIT License，見 [LICENSE](LICENSE)。

---

## 免責聲明

本專案用於 GIS 研究、行動應用程式開發測試與位置服務原型驗證。請勿用於違反第三方服務條款或平台政策的用途。用於定位類遊戲或社群應用可能違反該平台條款，導致帳號被警告或停權；**開發者不負責任何帳號損失或衍生糾紛**。

- 本工具不修改 iOS 裝置內的使用者資料，也不變更作業系統檔案。
- iOS 17 以上需要以系統管理員權限建立虛擬網路介面，可能與 VPN 或防火牆軟體衝突。
- 地圖、路線與地址資料來自第三方服務，不保證正確或即時。
- 使用者應遵守所在地法律，濫用或違法使用的責任由使用者自行承擔。

GeoMirage 是個人維護的開源專案，不是商業產品，不保證能在所有裝置與系統設定下運作，也不保證持續維護。

**下載、安裝或執行本軟體，即表示你已閱讀並同意以上條款。**
