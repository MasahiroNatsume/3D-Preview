# 厚盛り印刷 3Dプレビューシステム

Google Docsの要件定義書、および [ヤマテ・サイン公式Webサイト](https://yamate-sign.jp/) のデザイン・トンマナに準拠した厚盛り印刷3D確認システムです。

---

## 🌟 特徴

1. **秘密トークンによるURL共有**
   - 192ビット（32文字のランダムURLセーフ文字列）のエンドポイント `/p/<token>` により、**リンクを受け取った関係者・クライアントのみ**が閲覧可能。
   - `X-Robots-Tag: noindex, nofollow, noarchive` および `Referrer-Policy: no-referrer` を付与し、検索エンジンの巡回やリファラ漏洩を完全防止。
   - 有効期限（日数指定）や管理画面からのワンクリック削除にも対応。

2. **Blender準拠の直感的なカメラ操作**
   - **中ボタンドラッグ / 2本指スライド**: 回転（ターンテーブル式）
   - **Shift + 中ボタンドラッグ / Shift + 2本指スライド**: 移動（パン）
   - **ホイール / ピンチ / Ctrl + 2本指 / Ctrl + 中ボタン**: 拡大・縮小（ズーム）
   - ※ マウス左ドラッグ（回転）・右ドラッグ（移動）やスマホ・タブレットのタッチ操作にも対応。
   - **キーボードショートカット（テンキー対応）**:
     - `1`: 正面視点（Ctrlで背面）
     - `3`: 右側面視点（Ctrlで左側面）
     - `7`: 上面視点（Ctrlで底面）
     - `5`: 透視投影 (Perspective) ⇄ 平行投影 (Orthographic) 切り替え
     - `.` / `Home`: 全体表示（Fit to Frame）
     - `0`: 初期視点
     - `2` / `4` / `6` / `8`: 15°刻みの回転

3. **厚盛り印刷レイヤーのリアルタイム3D再現**
   - **Base**（大きな形状）＋ **Texture**（細かな凹凸）を合成して高さメッシュと高精度法線マップを動的生成。
   - **Color**（表面印刷）をマッピング。
   - **Varnish**（ニス層）を物理ベースのクリアコート（Clearcoat）として再現し、光の当たり方でツヤ・反射をリアルに確認可能。
   - **高さ強調スライダー**（×1.0 実寸 〜 ×20.0 強調）：微細な凹凸も視覚的にわかりやすく確認。
   - **ライティング操作**: 光源の向き（方位・仰角・光量）を動かして凹凸の陰影を詳細チェック。

4. **ヤマテ・サイン様を意識したUIデザイン**
   - モノトーン主体の洗練されたタイポグラフィ（Barlow × 日本語ゴシック）。
   - 英語大見出し ＋ 小さな日本語ラベル。
   - コーポレートのアクセントグラデーションライン。
   - 印刷仕様情報（Base / Texture / Color / Varnish のインク濃度・積層回数・想定高さ）のスマートな表示。

---

## 🚀 クイックスタート

### 1. サーバーの起動

追加の外部ライブラリ（pip等）は不要です（Python 3.9+ の標準ライブラリのみで動作）。

```bash
# サーバー起動（Python 3.9+ 標準ライブラリのみで動作）
ADMIN_PASSWORD=my_secure_password python3 server.py --port 8000

# または、手元のMacから即座に世界中へ公開する場合（登録不要・完全無料）
./tools/share.sh
```

ブラウザで以下を開きます：
- 管理画面：`http://localhost:8000/admin` （ユーザー名: `admin` / パスワード: 上記で設定したもの）

### 2. サンプルデータの生成・登録（動作確認用）

すでに花の厚盛りサインのサンプルデータが生成・登録されています。
新たにサンプルを発行したい場合は以下を実行します：

```bash
python3 tools/make_sample.py --install
```

コマンド実行後に表示されるURL（例: `http://localhost:8000/p/EeZYAJElyXcmvciJC2QV5myye2CWVXJm`）を開くだけで、即座に3Dプレビューを確認できます。

---

## 📁 データ仕様（要件定義 3-5 準拠）

大塚さん側のデータ生成ツールから出力される以下のファイルをそのままアップロード可能です：

| ファイル名 | 必須 | 役割 |
|---|---|---|
| `base.png` | ◯ | 大きな立体形状（白=高い、黒=低い/透明） |
| `texture.png` | 任意 | 細かな表面凹凸・シボ感 |
| `color.png` | 任意 | 表面のカラーインク画像 |
| `varnish.png` | 任意 | ニス・ツヤ層（白=光沢あり） |
| `original.png` | 任意 | 元画像（カラー画像との比較用） |
| `config.json` | 任意 | 寸法・積層回数・インク濃度などの設定 |

### `config.json` の記述例
```json
{
  "title": "店頭サインサンプル",
  "size_mm": { "width": 300, "height": 200 },
  "white_is_high": true,
  "board": { "thickness_mm": 3, "color": "#fafafa" },
  "layers": {
    "base": { "ink": "White", "density_percent": 900, "passes": 9, "max_height_mm": 1.5 },
    "texture": { "ink": "White", "density_percent": 200, "passes": 2, "max_height_mm": 0.25 },
    "color": { "ink": "CMYK", "density_percent": 100, "passes": 1 },
    "varnish": { "ink": "Gloss", "density_percent": 200, "passes": 2, "max_height_mm": 0.05 }
  },
  "note": "アクリル基材にホワイト900%盛り上げ後、グロスニスを花芯に塗布"
}
```

※ `config.json` を用意しなくても、管理画面のフォームから寸法や各レイヤーの高さを直接入力して発行することも可能です。

---

## Cloudflare Workersで管理APIを使う

管理APIはD1（案件情報）とR2（画像・モデルファイル）を使用します。ローカル開発ではCloudflareのローカルエミュレーターがストレージを用意します。

### ローカル開発

```powershell
Copy-Item .dev.vars.example .dev.vars
npx wrangler d1 migrations apply DB --local
npx wrangler dev
```

`.dev.vars` の `ADMIN_PASSWORD` はローカル用に変更してください。

### 本番デプロイ

1. CloudflareにD1データベースとR2バケットを作成します。

```powershell
npx wrangler d1 create 3d-preview
npx wrangler r2 bucket create 3d-preview-project-files
```

2. D1作成時に表示されたIDを `wrangler.jsonc` の `database_id` に設定します。
3. 管理画面のパスワードをCloudflare Secretとして登録し、マイグレーションを適用します。

```powershell
npx wrangler secret put ADMIN_PASSWORD
npx wrangler d1 migrations apply DB --remote
```

4. Workerをデプロイします。Wranglerがデプロイ前に `npm run build` を実行します。

```powershell
npx wrangler deploy
```

Workerが `/api/admin/*` と共有リンクを処理し、既存の静的サンプルは `dist/` から配信します。`meta.json` は公開ファイルとして配布されません。

---

## PSDからプレビュー用データを作る

変換用ライブラリをインストールします。

```powershell
python -m pip install -r tools/requirements-convert.txt
```

鷲サンプルのWB/WT/C版を処理する例です。WBをベース、WTをテクスチャとして分け、カラーデータと共有ビューアー用のトークン付きプロジェクト、OBJを `data/` に出力します。`--varnish` は実際のV版マップを確認できた場合だけ指定してください。

```powershell
python tools/convert_yamate.py `
   --base "C:\Users\happy\Downloads\送付用\送付用\鷲\ワシ-WB.psd" `
   --texture "C:\Users\happy\Downloads\送付用\送付用\鷲\ワシ-WT.psd" `
   --color "C:\Users\happy\Downloads\送付用\送付用\鷲\ワシ-C.psd" `
   --output data `
   --title "鷲サンプル" `
   --width-mm 300 `
   --base-density-percent 800 --base-passes 4 `
   --texture-density-percent 800 --texture-passes 4 `
```

実機高さは、議事録にある「白インク900%で約0.2mm/パス」と、実測1点「濃度50%で約30%の高さ」から近似します。後者から $h = x^{1.737}$ としており、機械固有の校正曲線ではありません。生成された `config.json` に校正値を保存し、ビューアーの「実高さ補正」をONにすると適用されます。OFFでは入力マップ値を表示します。

OBJは入力どおりの `model.obj` と、補正済みの `model-ink.obj` を両方出力します。ビューアーは同一ページでOBJモードに切り替わるため、共有プレビューではWB/WT/Color/Varnishのレイヤー表示を使い、OBJは外部ソフトでの確認用です。

ビューアーの「表示解像度」は初期状態が低解像度です。高解像度はPCで画像長辺4096px・メッシュ長辺2304分割（約0.2mm間隔）、モバイルでは負荷を抑えて2048px・768分割に制限します。案件画像の元解像度がこれより低い場合は、上げても情報自体は増えません。

Varnishとして使うPDFは、出力前に内容を確認してください。今回の鷲のV PDFは緑の小さな点のみを含み、見本PDFでは `V500% x 2` と記載されています。これが本当に艶版の全データか、版担当者へ確認する必要があります。
