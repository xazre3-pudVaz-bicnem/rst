# RST リアルタイム音声AIサーバー（realtime-voice-server）

RSTのAIテレアポで「相手が本当の人間と話しているような自然なAI会話」を実現するための中継サーバーです。
**Twilio Media Streams**（通話音声のリアルタイム双方向ストリーム）と **OpenAI Realtime API** を橋渡しし、
会話の中でアポ日程を取得して RST とGoogleカレンダーへツールAPI経由で登録します。

Vercelの通常API（サーバーレス）は常時起動WebSocketに不向きなため、**このサーバーだけ別ホスティング**
（Render / Railway / Fly.io / Cloud Run など常時起動できる環境）で動かします。

```
Twilio通話 ──(<Connect><Stream> wss)──▶ realtime-voice-server ──(wss)──▶ OpenAI Realtime
                                              │
                                              └─(HTTPS: /api/ai-call/twilio?action=tool-*)─▶ RST（案件/カレンダー/訪問予定）
```

## 必要な環境変数

| 変数 | 説明 | 例 |
|---|---|---|
| `OPENAI_API_KEY` | OpenAI APIキー（Realtime対応・課金必須） | `sk-...` |
| `OPENAI_REALTIME_MODEL` | Realtimeモデル | `gpt-realtime` |
| `OPENAI_REALTIME_VOICE` | 音声 | `marin`（日本語が自然な音声を選択） |
| `RST_API_BASE` | RST本番URL | `https://rst-chi.vercel.app` |
| `AI_CALL_SERVER_SECRET` | RSTとの共有シークレット（**RST側の同名envと必ず一致**） | 長いランダム文字列 |
| `PORT` | 待受ポート | `8080` |

## ローカル起動

```bash
cd apps/realtime-voice-server
cp .env.example .env      # 値を設定
npm install
# .env を読み込んで起動（Node 20+）
node --env-file=.env server.js
# ヘルスチェック: http://localhost:8080/health → ok
```

ローカルのWebSocketをTwilioから叩くには公開URLが必要です（`ngrok http 8080` 等でトンネルし、
`wss://<ngrok-domain>/twilio-stream` をRSTの `REALTIME_VOICE_SERVER_URL` に設定）。

## 本番デプロイ

いずれも Dockerfile で動きます（`npm start` = `node server.js`）。

- **Render**: New → Web Service → リポジトリ選択 → Root Directory `apps/realtime-voice-server` → 環境変数を設定 → Deploy。WebSocket対応。
- **Railway**: New Project → Deploy from repo → Root `apps/realtime-voice-server` → Variables 設定。
- **Fly.io**: `fly launch`（Dockerfile検出）→ `fly secrets set OPENAI_API_KEY=... AI_CALL_SERVER_SECRET=...` → `fly deploy`。
- **Cloud Run**: `gcloud run deploy rst-voice --source apps/realtime-voice-server --port 8080 --allow-unauthenticated` → 環境変数を設定。

デプロイ後の公開URL（例 `https://rst-voice.onrender.com`）の **wss** 版を控える → `wss://rst-voice.onrender.com`。

## Twilio 設定

このサーバーは Twilio の `<Connect><Stream>` からのWebSocketを受けます。TwiML自体は **RST側が生成**します
（`AI_CALL_MODE=realtime` の発信時に、RSTが以下のTwiMLをTwilioへ渡します）。

```xml
<Response>
  <Connect>
    <Stream url="wss://<voice-server>/twilio-stream">
      <Parameter name="jobId" value="..."/>
      <Parameter name="caseId" value="..."/>
    </Stream>
  </Connect>
</Response>
```

Twilioコンソール側の追加設定は基本不要（発信時にTwiMLをinlineで渡すため）。番号の音声機能が有効であること・
トライアル中は着信先が認証済み番号であることが必要です。

## RST側の環境変数（Vercel）

| 変数 | 説明 |
|---|---|
| `AI_CALL_MODE` | `fixed`（既定・固定音声） / `realtime`（このサーバーを使う） |
| `REALTIME_VOICE_SERVER_URL` | このサーバーの **wss** URL（例 `wss://rst-voice.onrender.com`） |
| `AI_CALL_SERVER_SECRET` | このサーバーと**同じ値** |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_PHONE_NUMBER` | 既存のTwilio設定 |

## 動作フロー

1. RSTの案件詳細「この案件に実発信」（管理者・**テストモードON=自分の番号**）で発信。
2. `AI_CALL_MODE=realtime` のとき、RSTは `<Connect><Stream wss://.../twilio-stream>` のTwiMLで発信。
3. 通話が始まると Twilio がこのサーバーへ音声をストリーム。サーバーは OpenAI Realtime へ中継。
4. AIが自然な音声で会話。前向きなら日程を聞き、`get_available_slots`→`create_appointment` でアポ登録。
5. 通話終了時、サーバーが RST へ結果をPOST（案件ログ・ステータス反映）。

## ツール（AIが会話中に呼ぶ → RSTへ中継）

`get_case_context` / `get_available_slots` / `create_appointment` / `schedule_callback` /
`mark_no_interest` / `save_call_summary`。いずれも
`POST {RST_API_BASE}/api/ai-call/twilio?action=tool-*`（`Authorization: Bearer AI_CALL_SERVER_SECRET`）で呼びます。

## 安全・制約（MVP）

- **最初は自分の電話番号のみ**でテスト（RST側テストモードONで発信先を自分の番号へ差し替え）。
- 営業先への本番発信はまだ禁止（テストモードOFFは管理者の明示操作）。
- 管理者のみリアルタイム発信可。NG案件は発信不可。90秒以内の同番号再発信禁止。同時発信は1件。
- AIは**完全NGを自動確定しない**（`mark_no_interest`まで。NG確定は管理者確認）。
- 録音・通話ログは従来どおり保存。

## 注意（要チューニング）

- OpenAI Realtime APIはイベント名/セッション設定が版により差があります（`response.audio.delta` /
  `response.output_audio.delta`、`input_audio_format` 等）。本実装は一般的なbeta形式に両対応していますが、
  実機テストで無音・片方向などが出たら `server.js` の session.update とイベント名を調整してください。
- Twilioは G.711 μ-law 8kHz。OpenAI側も `g711_ulaw` にしているため基本リサンプル不要です。
