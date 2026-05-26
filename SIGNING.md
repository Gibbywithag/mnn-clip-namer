# Mac Code Signing & Notarization

What this gets you: a signed, notarized `.dmg`. Anyone you send it to can open it
on any Mac — no "unidentified developer" warning, no right-click-Open dance.

The build config is already wired. You just need an Apple Developer Program
account and three credentials. **Steps 1–4 are one-time. Steps 5–6 are per-build.**

---

## 1. Apple Developer Program — $99/year

Go to https://developer.apple.com → **Apple Developer Program** → **Enroll**.

- Pick **Individual** (cheaper, fewer hoops). Use your personal Apple ID.
- Two-factor auth on your Apple ID is required — turn it on first if it isn't.
- Approval takes 24–48 hours. You'll get an email.

> If MNN has an organizational developer account, you can ask IT to add you
> to it instead. That's free for you. Otherwise: $99 on your card.

## 2. Generate a "Developer ID Application" certificate

Once enrolled:

1. Open **Xcode** → **Settings** (`⌘ ,`) → **Accounts** tab.
2. Click `+`, add your Apple ID, sign in.
3. Select your Apple ID → select your **team** (it'll show "Your Name (Personal Team)" or similar).
4. Click **Manage Certificates…**
5. Click `+` in the bottom-left → choose **Developer ID Application**.
6. The cert appears in Keychain Access automatically. Done.

(If "Developer ID Application" is greyed out, you're not enrolled yet — wait
for the approval email from step 1.)

## 3. Find your Team ID

https://developer.apple.com/account → scroll to **Membership Details** →
**Team ID** is a 10-character string (e.g. `ABCD123456`). Copy it.

## 4. Generate an app-specific password (for notarization)

Apple wants notarization auth separated from your main Apple ID password.

1. https://appleid.apple.com → **Sign-In and Security** → **App-Specific Passwords**.
2. Click `+`, name it `MNN Clip Namer notarization`.
3. Copy the 19-character password (looks like `xxxx-xxxx-xxxx-xxxx`). You can't
   see it again later, so save it now.

## 5. Save credentials locally (gitignored)

Create a file called `.env.signing` in the repo root:

```
APPLE_ID=your.apple.email@example.com
APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
APPLE_TEAM_ID=ABCD123456
```

Make sure it's in `.gitignore` (already is — see below).

## 6. Build a signed + notarized DMG

```bash
source .env.signing
npm run build:mac:signed
```

What happens:

1. TypeScript compiles, Vite bundles, electron-builder packages.
2. The `.app` is signed with your Developer ID certificate (from Keychain).
3. The `.dmg` is uploaded to Apple's notary service (5–20 min).
4. The notarization ticket is **stapled** to the DMG so it works offline.
5. Final output: `release/MNN Clip Namer-0.1.0-universal.dmg`.

That DMG can be sent to anyone. They double-click → drag to Applications → opens
clean. No warnings.

---

## Quick reference

| Command | When to use |
|---|---|
| `npm run build:mac` | Unsigned build — fast, for local testing. Shows "unidentified developer" on other Macs. |
| `npm run build:mac:signed` | Signed + notarized release build. Requires `APPLE_*` env vars. |
| `npm run build:win` | Windows portable .exe. Still unsigned (see SmartScreen workaround in README). |

## Troubleshooting

- **"No identity found"** — Cert isn't in Keychain. Redo step 2. Or run
  `security find-identity -p codesigning -v` to confirm; you should see a
  "Developer ID Application: Your Name (TEAMID)" entry.
- **"Notary service rejected"** — Usually means hardened runtime is breaking a
  native module. Check `build/entitlements.mac.plist` covers what you need.
  Currently set up for keytar + ffmpeg + ffprobe.
- **"Authentication failed" during notarization** — App-specific password is
  wrong, or you used your regular Apple ID password. Regenerate at
  appleid.apple.com.
- **Notarization stuck > 30 min** — Rare. Run
  `xcrun notarytool history --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD"`
  to see status.

## Windows is separate

Windows code signing is a totally different process (EV cert, USB hardware
token, $300–500/year). Not set up here. For internal MNN distribution the
"More Info → Run anyway" dance is fine. If your gov laptop's AppLocker
blocks the unsigned `.exe`, ask MNN IT for a publisher whitelist entry.
