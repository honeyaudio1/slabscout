# SlabScout

Trading card price guide, scanner and collection tracker for Pokémon, Magic and Yu-Gi-Oh!.

- Search cards with set, number, rarity and ungraded market price
- Graded values and last sold by company (PSA, Beckett, CGC, SGC, TAG)
- Scan a card from a photo to identify it
- Accounts with a personal collection and a value-over-time chart
- Password reset by email

## Run

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
.venv/bin/python server.py
```

Then open http://localhost:8765.

To open it from a phone on the same Wi-Fi, start it with `HOST=0.0.0.0` and browse to
`http://<your-computer's-IP>:8765`.

## Free version on GitHub Pages

The `docs/` folder is a no-server build: search, card pages and a collection saved in the browser.
It has no accounts and no scanning. Rebuild it after changing anything in `static/`:

```bash
python3 build_pages.py
```

## Host it online (Render)

1. Open https://dashboard.render.com/blueprint/new and connect this repository.
2. Render reads `render.yaml`, which sets up the web service and a disk for accounts and collections.
3. Fill in the keys it asks for. Set `SIGNUP_CODE` to keep sign-up invite-only.

## Optional keys (`.env`)

| Key | Enables |
|---|---|
| `ANTHROPIC_API_KEY` | Card scanning |
| `PRICECHARTING_TOKEN` | Real graded and ungraded values (paid API, personal-use licence) |
| `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET` | Real eBay sold listings (needs Marketplace Insights access) |
| `SMTP_*`, `APP_URL` | Password-reset emails |

Without a price source, graded values and sold listings are sample estimates and are labelled as such.

Card data comes from TCGdex, Scryfall and YGOPRODeck. SlabScout is an independent project and is not
affiliated with any price guide, marketplace or grading company.
