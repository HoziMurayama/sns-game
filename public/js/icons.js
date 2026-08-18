/**
 * アイコン（インラインSVG）。
 *
 * なぜ絵文字をやめたか:
 *   絵文字は端末ごとに見た目が変わります（Windows・iPad・Chromebook でまったく別の絵）。
 *   学校では3種類の端末が同じ教室に並ぶため、絵文字だと画面がそろいません。
 *   また絵文字は多色なので、色付きの丸の上に白抜きで置くことができません。
 *
 * なぜ外部SVGファイルにしないか:
 *   `<use href="/img/icons.svg#id">` の外部参照は Safari が対応していません。
 *   同じ内容をページ内に差し込む方式なら、どのブラウザでも同じように出ます。
 */

const SPRITE = `
<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true"
     style="position:absolute;width:0;height:0;overflow:hidden">
  <defs>

    <!-- カカオ農家: 芽（葉はふっくらした楕円。細い弧だと小さいとき線に見えてしまう） -->
    <symbol id="i-farm" viewBox="0 0 24 24">
      <path d="M10.7 21.8v-8.6h2.6v8.6z"/>
      <ellipse cx="7.1" cy="9.6" rx="5.1" ry="3.5" transform="rotate(-34 7.1 9.6)"/>
      <ellipse cx="16.9" cy="9.6" rx="5.1" ry="3.5" transform="rotate(34 16.9 9.6)"/>
    </symbol>

    <!-- 協同組合: 握手（左右の手が中央で合わさる。合わせ目に線を入れて2つの手に見せる） -->
    <symbol id="i-coop" viewBox="0 0 24 24">
      <rect x="0.6" y="11.4" width="7" height="2.6" rx="1.3"/>
      <rect x="16.4" y="11.4" width="7" height="2.6" rx="1.3"/>
      <path d="M8.6 9.2H12v8.2H8.6A2.6 2.6 0 0 1 6 14.8v-3A2.6 2.6 0 0 1 8.6 9.2z"/>
      <path d="M15.4 9.2H12v8.2h3.4a2.6 2.6 0 0 0 2.6-2.6v-3a2.6 2.6 0 0 0-2.6-2.6z"/>
      <path d="M7.6 9.6 11.4 6.2l1.5 1.7-3.8 3.4z"/>
      <path d="M16.4 9.6 12.6 6.2l-1.5 1.7 3.8 3.4z"/>
      <g stroke="#000" stroke-opacity=".32" stroke-width="1.2" stroke-linecap="round">
        <path d="M12 9.8v7"/>
      </g>
    </symbol>

    <!-- 輸出: 船 -->
    <symbol id="i-ship" viewBox="0 0 24 24">
      <path d="M11.2 2.6h1.6v10h-1.6z"/>
      <path d="M13.8 3.8 20 7.2l-6.2 3.1z"/>
      <path d="M10.2 5.4 4.6 8.2l5.6 2.8z"/>
      <path d="M2.2 13.8h19.6l-2.4 4.8a3.4 3.4 0 0 1-3.1 1.9H7.7a3.4 3.4 0 0 1-3.1-1.9z"/>
    </symbol>

    <!-- チョコレート会社: 工場 -->
    <symbol id="i-factory" viewBox="0 0 24 24">
      <path fill-rule="evenodd" d="M3 20.4V11l5.2 2.9V11l5.2 2.9V11l5.2 2.9V20.4zM9.8 15.6h2.2v2.2H9.8zm4.4 0h2.2v2.2h-2.2z"/>
      <path d="M17.6 3.6h2.8v6.2h-2.8z"/>
    </symbol>

    <!-- お店: 店 -->
    <symbol id="i-shop" viewBox="0 0 24 24">
      <path d="M3.2 4.6h17.6a1 1 0 0 1 1 1.2l-.7 3.4H2.9l-.7-3.4a1 1 0 0 1 1-1.2z"/>
      <path fill-rule="evenodd" d="M4.4 10.6h15.2v9.8h-4.8v-5.4H9.2v5.4H4.4z"/>
    </symbol>

    <!-- 消費者: 人 -->
    <symbol id="i-consumer" viewBox="0 0 24 24">
      <circle cx="8.6" cy="7.4" r="3.4"/>
      <path d="M8.6 12.2c-3.4 0-6.2 2.3-6.8 5.4-.2.9.5 1.7 1.4 1.7h10.8c.9 0 1.6-.8 1.4-1.7-.6-3.1-3.4-5.4-6.8-5.4z"/>
      <circle cx="17.6" cy="8.6" r="2.7"/>
      <path d="M17.6 12.8c-.9 0-1.7.2-2.4.6 1.4 1.2 2.4 2.8 2.8 4.6h3.6c.8 0 1.4-.7 1.2-1.5-.5-2.2-2.6-3.7-5.2-3.7z"/>
    </symbol>

    <!-- 参加ボタン用: 人（消費者と同じ形） -->
    <symbol id="i-users" viewBox="0 0 24 24">
      <circle cx="8.6" cy="7.4" r="3.4"/>
      <path d="M8.6 12.2c-3.4 0-6.2 2.3-6.8 5.4-.2.9.5 1.7 1.4 1.7h10.8c.9 0 1.6-.8 1.4-1.7-.6-3.1-3.4-5.4-6.8-5.4z"/>
      <circle cx="17.6" cy="8.6" r="2.7"/>
      <path d="M17.6 12.8c-.9 0-1.7.2-2.4.6 1.4 1.2 2.4 2.8 2.8 4.6h3.6c.8 0 1.4-.7 1.2-1.5-.5-2.2-2.6-3.7-5.2-3.7z"/>
    </symbol>

    <!-- カカオの実（見出しの飾り・入力欄のラベル） -->
    <symbol id="i-pod" viewBox="0 0 24 24">
      <ellipse cx="12" cy="12.8" rx="5.4" ry="8.4"/>
      <path d="M12 3.6c.7-1.2 1.9-1.9 3.2-2" fill="none" stroke="currentColor"
            stroke-width="1.9" stroke-linecap="round"/>
      <path d="M9.4 7.6c-.9 3.4-.9 6.9 0 10.4M14.6 7.6c.9 3.4.9 6.9 0 10.4"
            fill="none" stroke="#fff" stroke-width="1" stroke-linecap="round" opacity=".3"/>
    </symbol>

    <!-- 1人（参加者一覧のアイコン） -->
    <symbol id="i-person" viewBox="0 0 24 24">
      <circle cx="12" cy="7.6" r="4.3"/>
      <path d="M12 13.6c-4.3 0-7.9 2.9-8.7 6.8-.2 1 .6 1.9 1.6 1.9h14.2c1 0 1.8-.9 1.6-1.9-.8-3.9-4.4-6.8-8.7-6.8z"/>
    </symbol>

    <!-- 歯車（ルーム設定） -->
    <symbol id="i-gear" viewBox="0 0 24 24">
      <g>
        <rect x="10.9" y="1.4" width="2.2" height="4.8" rx="1.1"/>
        <rect x="10.9" y="1.4" width="2.2" height="4.8" rx="1.1" transform="rotate(45 12 12)"/>
        <rect x="10.9" y="1.4" width="2.2" height="4.8" rx="1.1" transform="rotate(90 12 12)"/>
        <rect x="10.9" y="1.4" width="2.2" height="4.8" rx="1.1" transform="rotate(135 12 12)"/>
        <rect x="10.9" y="1.4" width="2.2" height="4.8" rx="1.1" transform="rotate(180 12 12)"/>
        <rect x="10.9" y="1.4" width="2.2" height="4.8" rx="1.1" transform="rotate(225 12 12)"/>
        <rect x="10.9" y="1.4" width="2.2" height="4.8" rx="1.1" transform="rotate(270 12 12)"/>
        <rect x="10.9" y="1.4" width="2.2" height="4.8" rx="1.1" transform="rotate(315 12 12)"/>
      </g>
      <path fill-rule="evenodd" d="M12 4.4a7.6 7.6 0 1 0 0 15.2 7.6 7.6 0 0 0 0-15.2zm0 4.4a3.2 3.2 0 1 1 0 6.4 3.2 3.2 0 0 1 0-6.4z"/>
    </symbol>

    <!-- 本（ゲームの進め方） -->
    <symbol id="i-book" viewBox="0 0 24 24">
      <path d="M2.6 4.4h6.6a2.8 2.8 0 0 1 2.8 2v13a2.8 2.8 0 0 0-2.8-2H2.6z"/>
      <path d="M21.4 4.4h-6.6a2.8 2.8 0 0 0-2.8 2v13a2.8 2.8 0 0 1 2.8-2h6.6z"/>
    </symbol>

    <!-- 再生（開始を待っています） -->
    <symbol id="i-play" viewBox="0 0 24 24">
      <path d="M7.6 4.6 19.4 12 7.6 19.4z"/>
    </symbol>

    <!-- 砂時計（参加待ちの枠） -->
    <symbol id="i-hourglass" viewBox="0 0 24 24">
      <path d="M6 2.6h12v2.2h-1.2c0 3-1.6 5.4-3.6 7.2 2 1.8 3.6 4.2 3.6 7.2H18v2.2H6v-2.2h1.2c0-3 1.6-5.4 3.6-7.2C8.8 10.2 7.2 7.8 7.2 4.8H6z"/>
    </symbol>

    <!-- 電球（設定のポイント） -->
    <symbol id="i-bulb" viewBox="0 0 24 24">
      <path d="M12 1.8a7.4 7.4 0 0 0-4.3 13.4c.6.4 1 1.1 1 1.9v.3h6.6v-.3c0-.8.4-1.5 1-1.9A7.4 7.4 0 0 0 12 1.8z"/>
      <rect x="8.7" y="18.6" width="6.6" height="1.9" rx=".95"/>
      <rect x="9.6" y="21.2" width="4.8" height="1.6" rx=".8"/>
    </symbol>

    <!-- 旗（ルームを作成する） -->
    <symbol id="i-flag" viewBox="0 0 24 24">
      <rect x="3.6" y="2.2" width="2.3" height="19.6" rx="1.15"/>
      <path d="M7.4 3.2h12.2a.9.9 0 0 1 .7 1.5l-3 3.6 3 3.6a.9.9 0 0 1-.7 1.5H7.4z"/>
    </symbol>

    <!-- 鍵（個人情報の注意書き） -->
    <symbol id="i-lock" viewBox="0 0 24 24">
      <path d="M6.4 10.4h11.2a1.8 1.8 0 0 1 1.8 1.8v7.2a1.8 1.8 0 0 1-1.8 1.8H6.4a1.8 1.8 0 0 1-1.8-1.8v-7.2a1.8 1.8 0 0 1 1.8-1.8z"/>
      <path d="M8.4 10.4V7.8a3.6 3.6 0 0 1 7.2 0v2.6" fill="none" stroke="currentColor"
            stroke-width="2" stroke-linecap="round"/>
    </symbol>

  </defs>
</svg>`;

let injected = false;

/** ページの先頭にアイコン定義を差し込む（1回だけ） */
export function injectSprite(doc = document) {
  if (injected) return;
  injected = true;
  const holder = doc.createElement('div');
  holder.setAttribute('aria-hidden', 'true');
  holder.innerHTML = SPRITE;
  // innerHTML が使えない環境（テストの簡易DOM）でも落ちないようにする
  if (doc.body && typeof doc.body.appendChild === 'function') {
    doc.body.appendChild(holder);
  }
  return holder;
}

export { SPRITE };
