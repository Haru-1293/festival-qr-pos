# カードデザイン XML 仕様(version 1)

カードのデザイン(カード・ログインカードの印刷レイアウト)を、XMLファイルとして書き出し・読み込みするための形式です。
画面の「デザイン」タブ(管理者)と、デザインエディタの「XMLを書き出す / XMLを読み込む」から使えます。

- 文字コード: UTF-8
- 拡張子: `.xml`
- ファイルサイズ: 2MBまで(背景画像のbase64を含む)
- 読み込み時は、保存するときと同じ検証(範囲・形式)をします。違反があるとエラーになり、何も変更されません。
- 外部実体・DTD は読み込みません。

## 全体の形

```xml
<?xml version="1.0" encoding="UTF-8"?>
<cardDesign version="1" kind="CARD" name="夏祭り2026">
  <page widthMm="55" heightMm="91" background="#ffffff" gapMm="4"/>
  <image mime="image/png" fit="cover" x="0" y="0" w="100" h="100">iVBORw0KGgo...</image>
  <layers>
    <element key="festival" visible="true" x="5" y="4" w="90" fontMm="3.2" align="center" color="#06a850" bold="true"/>
    <element key="qr" visible="true" x="15" y="14" w="70" fontMm="0" align="center" color="#000000" bold="false"/>
    <element key="displayNo" visible="true" x="5" y="74" w="90" fontMm="5" align="center" color="#000000" bold="true"/>
    <element key="pin" visible="true" x="5" y="82" w="90" fontMm="3.6" align="center" color="#000000" bold="true"/>
    <element key="expiry" visible="true" x="5" y="91" w="90" fontMm="2.6" align="center" color="#555555" bold="false"/>
  </layers>
</cardDesign>
```

座標・大きさの `x` `y` `w` `h` は、**カード(用紙)の幅・高さに対する %** です。左上が (0, 0)。

## `<cardDesign>`(ルート・必須)

| 属性 | 必須 | 値 | 説明 |
|---|---|---|---|
| `version` | 必須 | `1` | 仕様のバージョン。対応していない値は読み込めません |
| `kind` | 必須 | `CARD` / `LOGIN` | `CARD`=QRカード、`LOGIN`=ログインカード(スタッフ・受付のログインQR) |
| `name` | 任意 | 文字列(40文字まで) | デザインの名前。なければ「読み込んだデザイン」 |

子要素は `page`(必須・1個)、`image`(任意・1個)、`layers`(必須・1個)。同じ要素が複数あるとエラーです。

## `<page>`(必須)

| 属性 | 必須 | 範囲 | 説明 |
|---|---|---|---|
| `widthMm` | 必須 | 30〜300 | カードの幅(mm) |
| `heightMm` | 必須 | 30〜400 | カードの高さ(mm) |
| `background` | 任意 | `#rrggbb` | 背景画像がないところの地の色。既定 `#ffffff` |
| `gapMm` | 任意 | 0〜30 | 1枚の用紙に複数枚並べるときの切り取り用の間隔(mm)。既定 0 |

## `<image>`(任意)

背景画像。**テキストの中身が base64**(`data:` の接頭辞は付けない)。改行・空白は無視されます。
レイヤーの中でいちばん奥に描かれます。

| 属性 | 必須 | 範囲 | 説明 |
|---|---|---|---|
| `mime` | 必須 | `image/png` / `image/jpeg` / `image/webp` | 画像の種類 |
| `fit` | 任意 | `cover` / `contain` | 枠の中での収め方。`cover`=枠いっぱい(はみ出しは切る)、`contain`=全体を収める。既定 `cover` |
| `x` `y` `w` `h` | 任意(4つとも書くか、4つとも省略) | x,y: -300〜400 / w,h: 1〜500 | 画像を置く枠(カードに対する %)。省略するとカード全面(0,0,100,100) |

画像データ(data URL に直した長さ)は約 900,000 文字までです(エディタが保存時に自動で縮小・圧縮します)。

## `<layers>`(必須)

`<element>` を **背面から最前面の順** に並べます(先頭ほど奥、末尾ほど手前)。背景画像は常に全 element より奥です。
1個以上、最大12個。

### `<element>`

| 属性 | 必須 | 範囲 | 説明 |
|---|---|---|---|
| `key` | 必須 | 下表 | 載せるものの種類。同じ `key` は1回だけ |
| `visible` | 任意 | `true` / `false` | 印刷するか。既定 `true` |
| `x` `y` | 必須 | -20〜120 | 左上の位置(%) |
| `w` | 必須 | 2〜150 | QR: 一辺の長さ(カード幅に対する %)。文字: 文字枠の幅(%) |
| `fontMm` | 任意 | 0〜40 | 文字の大きさ(mm)。QR では使いません(0 でよい)。既定 0 |
| `align` | 任意 | `left` / `center` / `right` | 文字のそろえ。既定 `center` |
| `color` | 任意 | `#rrggbb` | 文字の色。既定 `#000000` |
| `bold` | 任意 | `true` / `false` | 太字。既定 `false` |

#### `key` の種類

| key | `kind="CARD"` | `kind="LOGIN"` | 内容 |
|---|:-:|:-:|---|
| `qr` | ○ | ○ | QRコード(白い地の上に印刷。小さくしすぎると読み取れません) |
| `festival` | ○ | ○ | 祭の名前 |
| `displayNo` | ○ | | カード番号(例: C000123) |
| `expiry` | ○ | | 有効期限 |
| `pin` | ○ | | 発行時にPINを決めたカードは4桁のPIN、お客様が決めるカードはPINの記入欄(□□□□) |
| `name` | | ○ | 表示名 |
| `loginId` | | ○ | ログインID |
| `role` | | ○ | 役割(店員・店舗責任者・受付など) |
| `shop` | | ○ | 店舗名 |

`kind` に合わない `key` はエラーになります。**そのkindで使える要素のうち、XMLに書かれていないもの**は、読み込み時に標準の位置で最前面に追加されます(あとから増えた要素が抜け落ちないようにするため)。

## エラーになる主な例

- ルート要素が `cardDesign` でない / `version` が `1` でない
- `kind` が `CARD` / `LOGIN` 以外、または開いているデザインの種類と違う
- `page` や `layers` がない、または複数ある
- 数値が範囲外・数値でない、色が `#rrggbb` でない、`true`/`false` 以外の真偽値
- `key` が重複している、またはその `kind` で使えない
- `image` の `mime` が対応外、base64 が壊れている、画像が大きすぎる

## 最小の例

```xml
<?xml version="1.0" encoding="UTF-8"?>
<cardDesign version="1" kind="CARD" name="シンプル">
  <page widthMm="55" heightMm="91" background="#ffffff" gapMm="4"/>
  <layers>
    <element key="qr" x="15" y="14" w="70"/>
    <element key="displayNo" x="5" y="78" w="90" fontMm="5" bold="true"/>
  </layers>
</cardDesign>
```
