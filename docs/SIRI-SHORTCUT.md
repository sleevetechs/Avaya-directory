# iPhone Siri — employee extension lookup

Use **Siri Shortcuts** to ask for someone’s **Avaya extension** (e.g. “Rifaz” → **1854**). The Shortcut calls the directory server; Siri speaks the answer.

**API (production):** `https://directory.compasslog.com/api/lookup`

---

## How access works

Same rules as the public directory:

| Method | When to use |
|--------|-------------|
| **Office network** | iPhone on office Wi‑Fi; Shortcut may need **public IP headers** (see below). |
| **Directory passcode token** | Off-site: unlock directory once in Safari, then put the token in the Shortcut header **`X-Directory-Access`**. |
| **Siri token (optional)** | IT sets **`SIRI_LOOKUP_TOKEN`** in server `.env`; Shortcut sends header **`X-Siri-Token`** with that value. Easiest for Shortcuts off-site. |
| **Admin login** | Bearer token from admin login (rare for Siri). |

---

## API reference

### `GET /api/lookup?name=rifaz`

**Success (JSON):**

```json
{
  "found": true,
  "speak": "Rifaz's extension is 1854.",
  "extension": "1854",
  "mobile": "",
  "name": "Mohammed Rifaz …",
  "dept": "…",
  "branch": "…"
}
```

**Not found:**

```json
{ "found": false, "speak": "Sorry, no employee matched that name.", "extension": "" }
```

**Plain extension only (for simple Shortcuts):**

`GET /api/lookup?name=rifaz&format=text`  
→ response body: `1854` (or a short error sentence if not found).

### Optional headers (Shortcuts → Get Contents of URL → Headers)

| Header | Value |
|--------|--------|
| `X-Siri-Token` | Same as `SIRI_LOOKUP_TOKEN` on server |
| `X-Directory-Access` | Passcode unlock token from directory |
| `X-Client-Public-Ip` | Phone’s public IP (if office whitelist uses browser IP) |

---

## Server setup (IT)

1. Deploy latest code (`git pull`, restart Node).
2. Optional — add to `.env` on the server:

   ```env
   SIRI_LOOKUP_TOKEN=choose-a-long-random-secret-here
   ```

3. Restart the app after changing `.env`.
4. Test in a browser (while on office network or with token):

   `https://directory.compasslog.com/api/lookup?name=rifaz`

---

## Natural phrases (“Rifaz extension”, “what is the extension of Rifaz”, …)

The server **understands many wordings** if you send the **whole sentence** in the URL:

- `?q=what is the extension of rifaz`
- `?q=rifaz extension`
- `?q=rifaz ext`

Use **Dictate Text** (or type) in the Shortcut, then put that text in **`q=`** (not only `name=`).

---

## Build the Shortcut on iPhone

**Recommended:** **Dictate Text** so people can ask in their own words.

1. Open **Shortcuts** → **+** → **New Shortcut**.
2. Add **Dictate Text** → prompt e.g. “Ask about an extension” (or **Ask for Input** for name only).
3. Add **Text**: `https://directory.compasslog.com/api/lookup?q=` then **Combine** with Dictated Text.  
   *(Name-only variant: use `?name=` + input.)*
4. Add **Get Contents of URL**:
   - URL: Combined Text  
   - Method: **GET**  
   - Headers: `X-Siri-Token` = your secret (if IT gave you one)
5. Add **Get Dictionary from Input** (JSON from step 4).
6. Add **Get Dictionary Value** → key **`speak`**.
7. Add **Speak Text** → spoken result.
8. Name the shortcut **Compass extension**.
9. **Add to Siri** → phrase e.g. **“Compass extension”**.

**Try:** “Hey Siri, Compass extension” → say **What is Rifaz extension** or just **Rifaz extension** → hear the answer.

### Simpler variant (`format=text`)

URL: `https://directory.compasslog.com/api/lookup?name=[Input]&format=text`  
**Speak Text** uses the **Contents of URL** directly (digits only when found).

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| 403 / passcode message | Add `X-Siri-Token` or `X-Directory-Access`, or use office Wi‑Fi. |
| Wrong person | Use more of the full name; several matches returns an “ambiguous” message. |
| No extension spoken | Employee may have no ext in admin — update employee numbers. |
| 429 | Too many requests; wait an hour or use one token per user. |

---

## Security notes

- Treat **`SIRI_LOOKUP_TOKEN`** like a password; rotate if leaked.
- Prefer a **long random** token; do not commit it to GitHub.
- Lookup is rate-limited (about **120 requests per hour** per IP/token).
